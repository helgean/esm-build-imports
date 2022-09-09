# esm-imports-builder

Copies every file from source folder to output folder while adding hash versioning (cache busting) to all import statements in ESM modules. Modifies all .js files in output folder.

## Create a config.json file with source and output folder. Example:

```json
{
    "sourcedir": "./src",
    "outputdir": "./build",
    "excludes": [
        "*/ignoredfolder/**"
    ],
    "cleanOutput": false
}
```

If "outputdir" is omitted from the config file, the original files in the source folder will be modified in place.

If "excludes" is included, i should contain an array of glob patterns to exclude files/folders.

"cleanOutput": true - deletes output folder with all contents if "outputdir" is defined.


## Execute with:
```
> npm run build
```

or
```
> esm-build
```

### Arguments:
    -c [path to config file]

With arguments:
```
> npm build -- -c buildconfig.json
```

or
```
> esm-build -- -c buildconfig.json
```
