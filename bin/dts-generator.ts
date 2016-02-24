import generate from '../index';

export = function (argv: string[]): Promise<any> {
    const kwArgs: {
        [key: string]: any;
        externs?: string[];
        project?: string;
        verbose?: boolean;
    } = {}

    for (let i = 0; i < argv.length; ++i) {
        const arg = argv[i];

        if (arg.charAt(0) === '-') {
            const key = argv[i].replace(/^-+/, '');
            const value = argv[i + 1];
            ++i;

            if (key === 'extern') {
                if (!kwArgs.externs) {
                    kwArgs.externs = [];
                }

                kwArgs.externs.push(value);
            }
            else if (key === 'verbose') {
                kwArgs.verbose = true;
                /* decrement counter, because vebose does not take a value */
                --i;
            }
            else {
                kwArgs[key] = value;
            }
        }
    }

    ['name', 'out'].forEach(function (key) {
        if (!kwArgs[key]) {
            console.error(`Missing required argument "${key}"`);
            process.exit(1);
        }
    });

    return generate(<any> kwArgs)
}
