import { readFile, writeFile, mkdir, copyFile, rm, access, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { Url, RawUrl } from 'reurl'
import util from 'node:util'
import crypto from 'node:crypto'
import parseImports from 'parse-imports'
import minimatch from 'minimatch'

export default class ProcessFile {

    constructor(file, sourcedir, outputdir, excludes) {
        this.excludes = excludes || [];
        this.imports = [];
        this.references = [];
        this.reflevel = 0;
        this.file = file;
        this.relativeFile = path.relative(sourcedir, file);
        this.filePath = path.dirname(this.relativeFile);
        this.absolutePath = path.resolve(sourcedir, this.relativeFile);
        this.absoluteFilePath = path.resolve(sourcedir, this.filePath);
        this.outputPath = outputdir ? path.resolve(outputdir, this.relativeFile) : undefined;
        this.outputPathDir = this.outputPath ? path.dirname(this.outputPath) : undefined;
        this.readFile = util.promisify(readFile);
        this.hasImports = false;
    }

    // Read the content of the javascript file
    async fetchFile() {
        this.codeData = await this.readFile(this.file, 'utf8');
    }

    getImportFile(parsedUrl) {
        return parsedUrl ? `${parsedUrl.dirs.join('/')}/${parsedUrl.file}` : '';
    }

    matchExcludes(file, excludes) {
        for (let pattern of excludes) {
            if (minimatch(file, pattern)) {
                return true;
            }
        }
        return false;
    }

    // Read and parse imports
    async fetchImports() {
        const imports = [...(await parseImports(this.codeData))];

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
            const parsedUrl = importUrl ? new Url(importUrl) : undefined;
            const importFile = this.getImportFile(parsedUrl);
            const searchParams = new URLSearchParams(parsedUrl ? parsedUrl.query : '');
            const oldHash = searchParams.get('v');
            const absolutePath = path.resolve(this.absoluteFilePath, importFile);
            const relativePath = path.relative(this.absoluteFilePath, absolutePath);

            if (this.matchExcludes(relativePath, this.excludes)) {
                console.log('exclude: ' + relativePath);
                continue;
            }

            // Add to imports collection
            this.imports.push({
                importLine: importLine,
                moduleType: moduleType,
                importUrl: importUrl,
                parsedUrl: parsedUrl,
                importFile: importFile,
                oldHash: oldHash,
                absolutePath: absolutePath,
                relativePath: relativePath
            });
        }
    }

    generateVersion() {
        let hash = crypto.createHash('md5');
        hash.update(this.codeData);
        this.hashVersion = hash.digest('hex');
    }

    async process() {
        await this.fetchFile();
        await this.fetchImports();
        this.hasImports = Array.isArray(this.imports) && this.imports.length > 0;
    }
}