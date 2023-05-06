import inquirer from 'inquirer'
import path from 'path'
import fs from 'fs'
import TreePrompt from '../index.js'

inquirer.registerPrompt('tree', TreePrompt)

const directoriesOnly = false

function createDirectoryLister(dir) {
    return () =>
        fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((item) => !directoriesOnly || item.isDirectory())
            .map((item) => {
                const isDirectory = item.isDirectory()
                const resolved = path.resolve(dir, item.name)

                return {
                    name: item.name,
                    value: resolved + (isDirectory ? path.sep : ''),
                    children: isDirectory ? createDirectoryLister(resolved) : null,
                }
            })
}

inquirer
    .prompt([
        {
            type: 'tree',
            name: 'file',
            multiple: true,
            pageSize: 20,
            loop: false,
            message: 'Choose an item:',
            rootDirectory: process.cwd(),
            tree: createDirectoryLister(process.cwd()),
            validate: (resolved) => path.basename(resolved)[0] !== '.',
        },
    ])
    .then((answers) => {
        console.log(JSON.stringify(answers))
    })
