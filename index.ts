import * as fs from 'fs';
import * as mkdirp from 'mkdirp';
import * as pathUtil from 'path';
import * as Promise from 'bluebird';
import * as ts from 'typescript';

interface Options {
    exclude?: string[];
    eol?: string;
    includes?: string[];
    indent?: string;
    main?: string;
    name: string;
    out: string;
}

const filenameToMid: (filename: string) => string = (function () {
    if (pathUtil.sep === '/') {
        return function (filename: string) {
            return filename;
        };
    }
    else {
        const separatorExpression = new RegExp(pathUtil.sep.replace('\\', '\\\\'), 'g');
        return function (filename: string) {
            return filename.replace(separatorExpression, '/');
        };
    }
})();

function getError(diagnostics: ts.Diagnostic[]) {
    let message = 'Declaration generation failed';

    diagnostics.forEach(function (diagnostic) {
        const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);

        if (diagnostic.file == null) {
            message += diagnostic.messageText + "\n"
        }
        else {
            message +=
                `\n${diagnostic.file.fileName}(${position.line + 1},${position.character + 1}): ` +
                `error TS${diagnostic.code}: ${diagnostic.messageText}`;
        }
    });

    const error = new Error(message);
    error.name = 'EmitterError';
    return error;
}

function processTree(sourceFile: ts.SourceFile, replacer: (node: ts.Node) => string): string {
    let code = '';
    let cursorPosition = 0;

    function skip(node: ts.Node) {
        cursorPosition = node.end;
    }

    function readThrough(node: ts.Node) {
        code += sourceFile.text.slice(cursorPosition, node.pos);
        cursorPosition = node.pos;
    }

    function visit(node: ts.Node) {
        readThrough(node);

        if (node.flags & ts.NodeFlags.Private) {
            // skip private nodes
            skip(node)
            return
        }

        const replacement = replacer(node);

        if (replacement != null) {
            code += replacement;
            skip(node);
        }
        else {
            if (node.kind === ts.SyntaxKind.ClassDeclaration || node.kind === ts.SyntaxKind.InterfaceDeclaration || node.kind === ts.SyntaxKind.FunctionDeclaration) {
                code += "\n"
            }
            ts.forEachChild(node, visit);
        }
    }

    visit(sourceFile);
    code += sourceFile.text.slice(cursorPosition);

    return code;
}

export default function generate(options: Options): Promise<void> {
    const filename = 'tsconfig.json'
    const configText = fs.readFileSync(filename, {encoding: 'utf8'});
    const config = ts.parseConfigFileTextToJson(filename, configText)
    const baseDir = process.cwd()
    const compilerOptions = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, baseDir).options
    compilerOptions.declaration = true
    compilerOptions.sourceMap = false
    compilerOptions.inlineSourceMap = false
    compilerOptions.inlineSources = false
    compilerOptions.noEmitOnError = false
    // to get emmitted file names relative to tsconfig
    delete compilerOptions.outDir

    const target = compilerOptions.target || ts.ScriptTarget.Latest
    const eol = "\n"
    const nonEmptyLineStart = new RegExp(eol + '(?!' + eol + '|$)', 'g');
    const indent = options.indent == null ? '  ' : options.indent

    mkdirp.sync(pathUtil.dirname(options.out))
    const output = fs.createWriteStream(options.out, <any> {mode: parseInt('644', 8)});

    const program = ts.createProgram(config.config.files, compilerOptions)
    const diagnostics = ts.getPreEmitDiagnostics(program)
    if (diagnostics.length > 0) {
        throw getError(diagnostics)
    }

    return new Promise<void>(function (resolve, reject) {
        output.on('close', () => {
            resolve(undefined);
        });
        output.on('error', reject);

        for (let sourceFile of program.getSourceFiles()) {
            // source file is already a declaration file so should does not need to be pre-processed by the emitter
            if (sourceFile.fileName.endsWith('.d.ts')) {
                continue;
            }

            const emitOutput = program.emit(sourceFile, (filename: string, data: string) => {
                if (filename.endsWith('.d.ts')) {
                    writeDeclaration(ts.createSourceFile(filename, data, target, true))
                }
            })
            if ( emitOutput.diagnostics.length > 0) {
                reject(getError(
                    emitOutput.diagnostics
                        .concat(program.getSemanticDiagnostics(sourceFile))
                        .concat(program.getSyntacticDiagnostics(sourceFile))
                        .concat(program.getDeclarationDiagnostics(sourceFile))
                ));

                return true;
            }
        }

        if (options.main) {
            output.write(`declare module '${options.name}' {` + eol + indent);
            output.write(`import main = require('${options.main}');` + eol + indent);
            output.write('export = main;' + eol);
            output.write('}' + eol);
        }

        output.end();
    });

    function writeDeclaration(declarationFile: ts.SourceFile) {
        if (declarationFile.text.length === 0) {
            return
        }

        const sourceModuleId = options.name + '/' + declarationFile.fileName.slice(0, -5).replace(/\//g, '/')

        output.write('declare module \'' + sourceModuleId + '\' {' + eol + indent);

        const content = processTree(declarationFile, (node) => {
            if (node.kind === ts.SyntaxKind.ExternalModuleReference) {
                const expression = <ts.LiteralExpression> (<ts.ExternalModuleReference> node).expression;

                if (expression.text.charAt(0) === '.') {
                    return ' require(\'' + filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), expression.text)) + '\')';
                }
            }
            else if (node.kind === ts.SyntaxKind.DeclareKeyword) {
                return '';
            }
            else if (node.kind === ts.SyntaxKind.StringLiteral && (node.parent.kind === ts.SyntaxKind.ExportDeclaration || node.parent.kind === ts.SyntaxKind.ImportDeclaration)) {
                const text = (<ts.StringLiteralTypeNode> node).text;
                if (text.charAt(0) === '.') {
                    return ` '${filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), text))}'`;
                }
            }
        });

        let prev = content.replace(nonEmptyLineStart, '$&' + indent);
        prev = prev.replace(/;/g, '')
        if (indent != '    ') {
            prev = prev.replace(/    /g, indent)
        }

        // export is not required in the declaration
        prev = prev.replace(/export /g, '')

        output.write(prev)
        if (prev.charAt(prev.length - 1) != '\n') {
            output.write(eol)
        }
        output.write('}' + eol + eol)
    }
}
