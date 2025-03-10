import * as vscode from 'vscode'
import * as fs from 'fs'

import {BibtexUtils} from './bibtexformatterlib/bibtexutils'
import type {BibtexFormatConfig} from './bibtexformatterlib/bibtexutils'
import type {Extension} from '../main'

type DataBibtexJsonType = typeof import('../../data/bibtex-entries.json')
type DataBibtexOptionalJsonType = typeof import('../../data/bibtex-optional-entries.json')

export class BibtexCompleter implements vscode.CompletionItemProvider {
    private readonly extension: Extension
    private readonly entryItems: vscode.CompletionItem[] = []
    private readonly optFieldItems = Object.create(null) as { [key: string]: vscode.CompletionItem[] }
    private readonly bibtexUtils: BibtexUtils

    constructor(extension: Extension) {
        this.extension = extension
        this.bibtexUtils = new BibtexUtils(extension)
        const configuration = vscode.workspace.getConfiguration('latex-workshop')
        const citationBackend = configuration.get('intellisense.citation.backend')
        let entriesFile: string = ''
        let optEntriesFile: string = ''
        let entriesReplacements: {[key: string]: string[]} = {}
        switch (citationBackend) {
            case 'bibtex':
                entriesFile = `${this.extension.extensionRoot}/data/bibtex-entries.json`
                optEntriesFile = `${this.extension.extensionRoot}/data/bibtex-optional-entries.json`
                entriesReplacements = configuration.get('intellisense.bibtexJSON.replace') as {[key: string]: string[]}
                break
            case 'biblatex':
                entriesFile = `${this.extension.extensionRoot}/data/biblatex-entries.json`
                optEntriesFile = `${this.extension.extensionRoot}/data/biblatex-optional-entries.json`
                entriesReplacements = configuration.get('intellisense.biblatexJSON.replace') as {[key: string]: string[]}
                break
            default:
                this.extension.logger.addLogMessage(`Unknown citation backend: ${citationBackend}`)
                return
        }
        try {
            this.loadDefaultItems(entriesFile, optEntriesFile, entriesReplacements)
        } catch (err) {
            this.extension.logger.addLogMessage(`Error reading data: ${err}.`)
        }
    }

    private loadDefaultItems(entriesFile: string, optEntriesFile: string, entriesReplacements: {[key: string]: string[]}) {
        const entries: { [key: string]: string[] } = JSON.parse(fs.readFileSync(entriesFile, {encoding: 'utf8'})) as DataBibtexJsonType
        const optFields: { [key: string]: string[] } = JSON.parse(fs.readFileSync(optEntriesFile, {encoding: 'utf8'})) as DataBibtexOptionalJsonType

        const maxLengths: {[key: string]: number} = this.computeMaxLengths(entries, optFields)
        const entriesList: string[] = []
        Object.keys(entries).forEach(entry => {
            if (entry in entriesList) {
                return
            }
            if (entry in entriesReplacements) {
                this.entryItems.push(this.entryToCompletion(entry, entriesReplacements[entry], this.bibtexUtils.bibtexFormatConfig, maxLengths))
            } else {
                this.entryItems.push(this.entryToCompletion(entry, entries[entry], this.bibtexUtils.bibtexFormatConfig, maxLengths))
            }
            entriesList.push(entry)
        })
        Object.keys(optFields).forEach(entry => {
            this.optFieldItems[entry] = this.fieldsToCompletion(entry, optFields[entry], this.bibtexUtils.bibtexFormatConfig, maxLengths)
        })
    }

    private computeMaxLengths(entries: {[key: string]: string[]}, optFields: {[key: string]: string[]}): {[key: string]: number} {
        const maxLengths = Object.create(null) as { [key: string]: number }
        Object.keys(entries).forEach(key => {
            let maxFieldLength = 0
            entries[key].forEach(field => {
                maxFieldLength = Math.max(maxFieldLength, field.length)
            })
            if (key in optFields) {
                optFields[key].forEach(field => {
                    maxFieldLength = Math.max(maxFieldLength, field.length)
                })
            }
            maxLengths[key] = maxFieldLength
        })
        return maxLengths
    }

    private entryToCompletion(itemName: string, itemFields: string[], config: BibtexFormatConfig, maxLengths: {[key: string]: number}): vscode.CompletionItem {
        const suggestion: vscode.CompletionItem = new vscode.CompletionItem(itemName, vscode.CompletionItemKind.Snippet)
        suggestion.detail = itemName
        suggestion.documentation = `Add a @${itemName} entry`
        let count: number = 1

        // The following code is copied from BibtexUtils.bibtexFormat
        // Find the longest field name in entry
        let s: string = itemName + '{${0:key}'
        itemFields.forEach(field => {
            s += ',\n' + config.tab + (config.case === 'lowercase' ? field : field.toUpperCase())
            s += ' '.repeat(maxLengths[itemName] - field.length) + ' = '
            s += config.left + `$${count}` + config.right
            count++
        })
        s += '\n}'
        suggestion.insertText = new vscode.SnippetString(s)
        return suggestion
    }

    private fieldsToCompletion(itemName: string, fields: string[], config: BibtexFormatConfig, maxLengths: {[key: string]: number}): vscode.CompletionItem[] {
        const suggestions: vscode.CompletionItem[] = []
        fields.forEach(field => {
            const suggestion: vscode.CompletionItem = new vscode.CompletionItem(field, vscode.CompletionItemKind.Snippet)
            suggestion.detail = field
            suggestion.documentation = `Add ${field} = ${config.left}${config.right}`
            suggestion.insertText = new vscode.SnippetString(`${field}` + ' '.repeat(maxLengths[itemName] - field.length) + ` = ${config.left}$1${config.right},`)
            suggestions.push(suggestion)
        })
        return suggestions
    }

    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
        const currentLine = document.lineAt(position.line).text
        const prevLine = document.lineAt(position.line - 1).text
        if (currentLine.match(/@[a-zA-Z]*$/)) {
            // Complete an entry name
            return this.entryItems
        } else if (currentLine.match(/^\s*[a-zA-Z]*/) && prevLine.match(/(?:@[a-zA-Z]{)|(?:["}0-9],\s*$)/)) {
            // Add optional fields
            const optFields = this.provideOptFields(document, position)
            return optFields
        }
        return
    }

    private provideOptFields(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
        const pattern = /^\s*@([a-zA-Z]+)\{(?:[^,]*,)?\s$/m
        const content = document.getText(new vscode.Range(new vscode.Position(0, 0), position))
        const reversedContent = content.replace(/(\r\n)|\r/g, '\n').split('\n').reverse().join('\n')
        const match = reversedContent.match(pattern)
        if (match) {
            const entryType = match[1].toLowerCase()
            if (entryType in this.optFieldItems) {
                return this.optFieldItems[entryType]
            }
        }
        return []
    }
}
