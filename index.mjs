#!/usr/bin/env node
import { readFile, writeFile, mkdir, copyFile, rm, access, constants as fsConstants } from 'node:fs'
import { PerformanceObserver, performance } from 'node:perf_hooks'
import { Buffer } from 'node:buffer'
import util from 'node:util'
import path from 'node:path'
import url from 'node:url'
import crypto from 'node:crypto'
import { exit } from 'node:process'
import recursive from 'recursive-readdir'
import parseImports from 'parse-imports'
import minimatch from 'minimatch'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

const readFileAsync = util.promisify(readFile);
const writeFileAsync = util.promisify(writeFile);
const mkdirAsync = util.promisify(mkdir);
const copyFileAsync = util.promisify(copyFile);
const rmAsync = util.promisify(rm);
const accessAsync = util.promisify(access);

const separator = '-'.repeat(50);

function hashFile(fileData) {
    let hash = crypto.createHash('md5');
	hash.update(fileData);
	return hash.digest('hex');
}

function matchExcludes(file, excludes) {
    for (let pattern of excludes) {
        if (minimatch(file, pattern)) {
            return true;
        }
    }
    return false;
}

const argv = yargs(hideBin(process.argv))
  .option('config', {
    description: 'The path to an optional config file',
    alias: 'c',
    type: 'string'
  })
  .option('clean', {
    description: 'Remove all existing files in output folder',
    alias: 'd',
    type: 'boolean'
  })
  .help()
  .alias('help', 'h')
  .argv;

if (argv.time) {
  console.log('The current time is: ', new Date().toLocaleTimeString());
}

async function build() {

    console.log(argv.config);
    const configFile = argv.config || './buildconfig.json';

    // Read the config file
    const errConfig = await accessAsync(configFile, fsConstants.F_OK);
    if (errConfig) {
        console.error(errConfig);
        exit(1);
    }

    const configData = await readFileAsync(configFile, 'utf8');
    const config = JSON.parse(configData);

    const errSource = await accessAsync(config.sourcedir, fsConstants.F_OK);
    if (errSource) {
        console.error(errSource);
        exit(1);
    }

    console.log(`Start processing files from ${config.sourcedir}`);
    console.log(separator);

    const excludes = config.excludes || [];
    const useOutputDir = !!config.outputdir;
    const destNotExists = await accessAsync(config.sourcedir, fsConstants.F_OK);
    const destionationExists = !destNotExists;

    if (useOutputDir && destionationExists && (argv.clean === true || config.cleanOutput === true)) {
        console.log(`Remove existing files from ${config.outputdir}`);
        await rmAsync(path.resolve(config.outputdir), { recursive: true });
    }

    const relativeOutputFile = outputFile => {
        const absolutePath = path.resolve(config.outputdir);
        return path.relative(absolutePath, outputFile);
    };

    const outputFile = async (file, outputFile) => {
        const relativePath = relativeOutputFile(outputFile);
        console.log(`${relativePath} copied unmodified`);
        return await copyFileAsync(file, outputFile);
    };

    const updatedFiles = [];

    // Find recursively all files in the source directory
    const files = await recursive(config.sourcedir);

    for (let file of files) {

        const relativeFile = path.relative(config.sourcedir, file);
        const filePath = path.dirname(relativeFile);
        const absoluteFilePath = path.resolve(config.sourcedir, filePath);
        const outputPath = useOutputDir ? path.resolve(config.outputdir, relativeFile) : undefined;
        const outputPathDir = useOutputDir ? path.dirname(outputPath) : undefined;

        // create output directory if not exists
        if (useOutputDir)
            await mkdirAsync(outputPathDir, { recursive: true });

        // copy file if not js file and skip to next file
        if (path.extname(file).toLowerCase() !== '.js' || matchExcludes(file, excludes))        {
            // copy file without changes;
            if (useOutputDir)
                await outputFile(file, outputPath)
            continue;
        }

        // Read the content of the javascript file
        let codeData = await readFileAsync(file, 'utf8');

        // Parse all import statements
        const imports = [...(await parseImports(codeData))];

        // Check if js file has any import statements
        if (imports.length == 0)
        {
            // copy file without changes;
            if (useOutputDir)
                await outputFile(file, outputPath)
            continue;
        }

        console.log(`Found imports in ${file}, adding new version hash..`);
        console.log(separator);

        let indexModifier = 0;
        let isModified = false;

        // Process import statements
        for (let importLine of imports) {
            //console.log(importLine);
            const moduleType = importLine.moduleSpecifier.type;

            // Only process relative or absolute file imports
            if (moduleType !== 'relative' && moduleType !== 'absolute') {
                continue;
            }

            // Process import statement
            const importUrl = importLine.moduleSpecifier.value;
            const parsedUrl = importUrl ? new URL(importUrl) : undefined;
            const importFile = parsedUrl ? parsedUrl.pathname : '';
            const oldHash = parsedUrl ? parsedUrl.searchParams.get('v') : null;
            const absolutePath = path.resolve(absoluteFilePath, importFile);
            const relativePath = path.relative(absoluteFilePath, absolutePath);

            if (matchExcludes(relativePath, excludes)) {
                console.log('exclude: ' + relativePath);
                continue;
            }

            // Hash file content of the imported file
            const fileData = await readFileAsync(absolutePath, 'utf8');
            const hash = hashFile(fileData);

            if (oldHash != hash) {
                if (!updatedFiles[file])
                    updatedFiles[file] = {
                        file: file,
                        filePath: absoluteFilePath,
                        imports: []
                    };

                updatedFiles[file].imports.push({
                    file: importFile,
                    filePath: absolutePath,
                    hash: hash,
                    importLine: importLine
                });
            }

            /*
            const startIndex = importLine.startIndex + indexModifier;
            const endIndex = importLine.endIndex + indexModifier;

            // Change the import statements by adding version argument
            const codeLine = codeData.substring(startIndex, endIndex);
            const newCodeLine = codeLine.replace(importUrl, `${importFile}?v=${hash}`);

            console.log(newCodeLine);

            codeData = codeData.slice(0, Math.max(startIndex, 0)) + newCodeLine + codeData.slice(endIndex);

            indexModifier += newCodeLine.length - codeLine.length;

            isModified = true;
            */
        }

        console.log(separator);

        /*
        // Output the file to the destination directory with correct sub folder structure
        const outputFileData = new Uint8Array(Buffer.from(codeData));
        const err = await writeFileAsync(useOutputDir ? outputPath : file, outputFileData);
        if (err) throw err;

        const outRelativePath = useOutputDir ? relativeOutputFile(outputPath) : file;

        console.log(`${outRelativePath} written ${isModified ? 'modified' : 'unmodified'}`);
        */
    }


    const updateFiles = Object.keys(updatedFiles).map(file => updatedFiles[file]);

    for (let updateFile of updateFiles) {
        // Read the content of the javascript file
        let codeData = await readFileAsync(updateFile.file, 'utf8');
        let indexModifier = 0;
        let isModified = false;

        for (let importModule of updateFile.imports) {
            const importLine = importModule.importLine;
            const startIndex = importLine.startIndex + indexModifier;
            const endIndex = importLine.endIndex + indexModifier;

            // Change the import statements by adding version argument
            const codeLine = codeData.substring(startIndex, endIndex);
            const newCodeLine = codeLine.replace(importUrl, `${importFile}?v=${hash}`);

            console.log(newCodeLine);

            codeData = codeData.slice(0, Math.max(startIndex, 0)) + newCodeLine + codeData.slice(endIndex);

            indexModifier += newCodeLine.length - codeLine.length;

            isModified = true;
        }

        // Output the file to the destination directory with correct sub folder structure
        const outputFileData = new Uint8Array(Buffer.from(codeData));
        const err = await writeFileAsync(useOutputDir ? outputPath : updateFile.file, outputFileData);
        if (err) throw err;

        const outRelativePath = useOutputDir ? relativeOutputFile(outputPath) : updateFile.file;

        console.log(`${outRelativePath} written ${isModified ? 'modified' : 'unmodified'}`);
    }


    if (useOutputDir) {
        console.log(separator);
        console.log(`Finished outputting all files to ${config.outputdir}`);
    }
}

// Measure performance while executing build method
const wrapped = performance.timerify(build);

const obs = new PerformanceObserver((list) => {
  console.log(`Built in ${Math.round(list.getEntries()[0].duration)}ms.`);
  obs.disconnect();
});
obs.observe({ entryTypes: ['function'] });

(async () => await wrapped())();