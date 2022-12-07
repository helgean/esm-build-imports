#!/usr/bin/env node
import { readFile, writeFile, mkdir, copyFile, rm, access, constants as fsConstants } from 'node:fs'
import { PerformanceObserver, performance } from 'node:perf_hooks'
import { Buffer } from 'node:buffer'
import util from 'node:util'
import path from 'node:path'
import { Url, RawUrl } from 'reurl'
import crypto from 'node:crypto'
import { exit } from 'node:process'
import recursive from 'recursive-readdir'
import parseImports from 'parse-imports'
import minimatch from 'minimatch'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import ProcessFile from './processfile.mjs'

const readFileAsync = util.promisify(readFile);
const writeFileAsync = util.promisify(writeFile);
const mkdirAsync = util.promisify(mkdir);
const copyFileAsync = util.promisify(copyFile);
const rmAsync = util.promisify(rm);
const accessAsync = util.promisify(access);

const separator = '-'.repeat(50);

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

function matchExcludes(file, excludes) {
    for (let pattern of excludes) {
        if (minimatch(file, pattern)) {
            return true;
        }
    }
    return false;
}

function updateFilesDep(processFile, processedFiles, acc) {
    processFile.reflevel = Math.max(acc, processFile.reflevel);
    if (processFile.hasImports) {
        for (let imported of processFile.imports) {
            const importedFile = processedFiles[imported.absolutePath];
            if (importedFile) {
                if (importedFile.references.indexOf(processFile.absoluteFilePath) == -1)
                    importedFile.references.push(processFile.absoluteFilePath);
                updateFilesDep(importedFile, processedFiles, acc + 1);
            }
        }
    }
}

async function build() {

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
    const processedFiles = {};

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

    // Find recursively all files in the source directory
    const files = await recursive(config.sourcedir);

    for (let file of files) {

        const processFile = new ProcessFile(file, config.sourcedir, config.outputdir, excludes);

        // create output directory if not exists
        if (useOutputDir)
            await mkdirAsync(processFile.outputPathDir, { recursive: true });

        // copy file if not js file and skip to next file
        if (path.extname(file).toLowerCase() !== '.js' || matchExcludes(processFile.relativeFile, excludes)) {
            // copy file without changes;
            if (useOutputDir)
                await outputFile(file, processFile.outputPath)
            continue;
        }

        // Process imports in this file
        await processFile.process();
        processedFiles[processFile.absolutePath] = processFile;

        // Check if js file has any import statements
        if (!processFile.hasImports)
        {
            // copy file without changes;
            if (useOutputDir)
                await outputFile(file, processFile.outputPath)
            continue;
        }
    }

    // Update import dependency level
    for (let file in processedFiles) {
        updateFilesDep(processedFiles[file], processedFiles, 0);
    }

    // Perform the update on files that imports the changed files
    const updateFiles = Object.keys(processedFiles)
        .map(file => processedFiles[file])
        .sort((a, b) => b.reflevel - a.reflevel);


    for (let updateFile of updateFiles) {
        // Read the content of the javascript file
        let indexModifier = 0;
        let isModified = false;

        if (updateFile.hasImports) {
            console.log(`\n${updateFile.file} has imports, performing version updates:`);
            console.log(separator);
        }

        for (let importModule of updateFile.imports) {
            const importLine = importModule.importLine;
            const startIndex = importLine.startIndex + indexModifier;
            const endIndex = importLine.endIndex + indexModifier;

            const importFile = processedFiles[importModule.absolutePath];
            if (!importFile) {
                console.log(`Could not process ${importModule.absolutePath}`);
                continue;
            }
            await importFile.fetchFile();
            importFile.generateVersion();

            // Change the import statements by adding version argument
            const codeLine = updateFile.codeData.substring(startIndex, endIndex);
            const importUrl = importModule.importFile;
            const newCodeLine = codeLine.replace(importLine.moduleSpecifier.value, `${importUrl}?v=${importFile.hashVersion}`);
            console.log(newCodeLine);

            const codeData = updateFile.codeData.slice(0, Math.max(startIndex, 0)) + newCodeLine + updateFile.codeData.slice(endIndex);
            updateFile.codeData = codeData;
            indexModifier += newCodeLine.length - codeLine.length;

            isModified = true;
        }

        // Output the file to the destination directory with correct sub folder structure
        const outputFileData = new Uint8Array(Buffer.from(updateFile.codeData));
        const err = await writeFileAsync(useOutputDir ? updateFile.outputPath : updateFile.file, outputFileData);
        if (err) throw err;

        const outRelativePath = useOutputDir ? relativeOutputFile(updateFile.outputPath) : updateFile.file;
        if (isModified)
            console.log(separator);
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