import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as cp from 'child_process'
import * as cs from 'cross-spawn'
import * as os from 'os'
import * as tmp from 'tmp'
import {Mutex} from '../lib/await-semaphore'
import {replaceArgumentPlaceholders} from '../utils/utils'

import type {Extension} from '../main'

const maxPrintLine = '10000'
const texMagicProgramName = 'TeXMagicProgram'
const bibMagicProgramName = 'BibMagicProgram'

export class Builder {
    private readonly extension: Extension
    readonly tmpDir: string
    private currentProcess: cp.ChildProcessWithoutNullStreams | undefined
    disableBuildAfterSave: boolean = false
    disableCleanAndRetry: boolean = false
    private readonly buildMutex: Mutex
    private readonly waitingForBuildToFinishMutex: Mutex
    private readonly isMiktex: boolean = false
    private previouslyUsedRecipe: Recipe | undefined
    private previousLanguageId: string | undefined

    constructor(extension: Extension) {
        this.extension = extension
        try {
            this.tmpDir = tmp.dirSync({unsafeCleanup: true}).name.split(path.sep).join('/')
        } catch (e) {
            void vscode.window.showErrorMessage('Error during making tmpdir to build TeX files. Please check the environment variables, TEMP, TMP, and TMPDIR on your system.')
            console.log(`TEMP, TMP, and TMPDIR: ${JSON.stringify([process.env.TEMP, process.env.TMP, process.env.TMPDIR])}`)
            // https://github.com/James-Yu/LaTeX-Workshop/issues/2911#issuecomment-944318278
            if (/['"]/.exec(os.tmpdir())) {
                const msg = `The path of tmpdir cannot include single quotes and double quotes: ${os.tmpdir()}`
                void vscode.window.showErrorMessage(msg)
                console.log(msg)
            }
            throw e
        }
        this.buildMutex = new Mutex()
        this.waitingForBuildToFinishMutex = new Mutex()
        try {
            const pdflatexVersion = cp.execSync('pdflatex --version')
            if (pdflatexVersion.toString().match(/MiKTeX/)) {
                this.isMiktex = true
                this.extension.logger.addLogMessage('pdflatex is provided by MiKTeX')
            }
        } catch (e) {
            this.extension.logger.addLogMessage('Cannot run pdflatex to determine if we are using MiKTeX')
        }
    }

    /**
     * Kill the current building process.
     */
    kill() {
        const proc = this.currentProcess
        if (proc) {
            const pid = proc.pid
            try {
                this.extension.logger.addLogMessage(`Kill child processes of the current process. PPID: ${pid}`)
                if (process.platform === 'linux' || process.platform === 'darwin') {
                    cp.execSync(`pkill -P ${pid}`, { timeout: 1000 })
                } else if (process.platform === 'win32') {
                    cp.execSync(`taskkill /F /T /PID ${pid}`, { timeout: 1000 })
                }
            } catch (e) {
                if (e instanceof Error) {
                    this.extension.logger.addLogMessage(`Error when killing child processes of the current process. ${e.message}`)
                }
            } finally {
                proc.kill()
                this.extension.logger.addLogMessage(`Kill the current process. PID: ${pid}`)
            }
        } else {
            this.extension.logger.addLogMessage('LaTeX build process to kill is not found.')
        }
    }

    /**
     * Should not use. Only for integration tests.
     */
    isBuildFinished(): boolean {
        return this.buildMutex.count === 1
    }

    private isWaitingForBuildToFinish(): boolean {
        return this.waitingForBuildToFinishMutex.count < 1
    }

    private async preprocess(): Promise<() => void> {
        const configuration = vscode.workspace.getConfiguration('latex-workshop')
        this.disableBuildAfterSave = true
        await vscode.workspace.saveAll()
        setTimeout(() => this.disableBuildAfterSave = false, configuration.get('latex.autoBuild.interval', 1000) as number)
        const releaseWaiting = await this.waitingForBuildToFinishMutex.acquire()
        const releaseBuildMutex = await this.buildMutex.acquire()
        releaseWaiting()
        return releaseBuildMutex
    }

    /**
     * Execute a command building LaTeX files.
     *
     * @param command The name of the command to build LaTeX files.
     * @param args The arguments of the command.
     * @param pwd The path of the working directory of building.
     * @param rootFile The root file to be compiled.
     */
    async buildWithExternalCommand(command: string, args: string[], pwd: string, rootFile: string | undefined = undefined) {
        if (this.isWaitingForBuildToFinish()) {
            return
        }
        const releaseBuildMutex = await this.preprocess()
        this.extension.logger.displayStatus('sync~spin', 'statusBar.foreground')
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
        const wd = workspaceFolder?.uri.fsPath || pwd

        if (rootFile !== undefined) {
            args = args.map(replaceArgumentPlaceholders(rootFile, this.tmpDir))
        }
        this.extension.logger.addLogMessage(`Build using the external command: ${command} ${args.length > 0 ? args.join(' '): ''}`)
        this.extension.logger.addLogMessage(`cwd: ${wd}`)
        this.currentProcess = cs.spawn(command, args, {cwd: wd})
        const pid = this.currentProcess.pid
        this.extension.logger.addLogMessage(`External build process spawned. PID: ${pid}.`)

        let stdout = ''
        this.currentProcess.stdout.on('data', (newStdout: Buffer | string) => {
            stdout += newStdout
            this.extension.logger.addCompilerMessage(newStdout.toString())
        })

        let stderr = ''
        this.currentProcess.stderr.on('data', (newStderr: Buffer | string) => {
            stderr += newStderr
            this.extension.logger.addCompilerMessage(newStderr.toString())
        })

        this.currentProcess.on('error', err => {
            this.extension.logger.addLogMessage(`Build fatal error: ${err.message}, ${stderr}. PID: ${pid}. Does the executable exist?`)
            this.extension.logger.displayStatus('x', 'errorForeground', undefined, 'error')
            void this.extension.logger.showErrorMessageWithExtensionLogButton(`Build terminated with fatal error: ${err.message}.`)
            this.currentProcess = undefined
            releaseBuildMutex()
        })

        this.currentProcess.on('exit', async (exitCode, signal) => {
            this.extension.compilerLogParser.parse(stdout)
            if (exitCode !== 0) {
                this.extension.logger.addLogMessage(`Build returns with error: ${exitCode}/${signal}. PID: ${pid}.`)
                this.extension.logger.displayStatus('x', 'errorForeground', undefined, 'warning')
                void this.extension.logger.showErrorMessageWithCompilerLogButton('Build terminated with error.')
            } else {
                this.extension.logger.addLogMessage(`Successfully built. PID: ${pid}`)
                this.extension.logger.displayStatus('check', 'statusBar.foreground', 'Build succeeded.')
                try {
                    if (rootFile === undefined) {
                        this.extension.viewer.refreshExistingViewer()
                    } else {
                        await this.buildFinished(rootFile)
                    }
                } finally {
                    this.currentProcess = undefined
                    releaseBuildMutex()
                }
            }
            this.currentProcess = undefined
            releaseBuildMutex()
        })
    }

    private buildInitiator(rootFile: string, languageId: string, recipeName: string | undefined = undefined, releaseBuildMutex: () => void) {
        const steps = this.createSteps(rootFile, languageId, recipeName)
        if (steps === undefined) {
            this.extension.logger.addLogMessage('Invalid toolchain.')
            return
        }
        this.buildStep(rootFile, steps, 0, recipeName || 'Build', releaseBuildMutex) // use 'Build' as default name
    }

    /**
     * Build a LaTeX file with user-defined recipes.
     *
     * @param rootFile The root file to be compiled.
     * @param languageId The name of the language of a file to be compiled.
     * @param recipeName The name of a recipe to be used.
     */
    async build(rootFile: string, languageId: string, recipeName: string | undefined = undefined) {
        if (this.isWaitingForBuildToFinish()) {
            this.extension.logger.addLogMessage('Another LaTeX build processing is already waiting for the current LaTeX build to finish. Exit.')
            return
        }
        const releaseBuildMutex = await this.preprocess()
        this.disableCleanAndRetry = false
        this.extension.logger.displayStatus('sync~spin', 'statusBar.foreground')
        this.extension.logger.addLogMessage(`Build root file ${rootFile}`)
        try {
            // Create sub directories of output directory
            // This was supposed to create the outputDir as latexmk does not
            // take care of it (neither does any of latex command). If the
            //output directory does not exist, the latex commands simply fail.
            const rootDir = path.dirname(rootFile)
            let outDir = this.extension.manager.getOutDir(rootFile)
            if (!path.isAbsolute(outDir)) {
                outDir = path.resolve(rootDir, outDir)
            }
            this.extension.logger.addLogMessage(`outDir: ${outDir}`)
            this.extension.manager.getIncludedTeX(rootFile).forEach(file => {
                const relativePath = path.dirname(file.replace(rootDir, '.'))
                const fullOutDir = path.resolve(outDir, relativePath)
                // To avoid issues when fullOutDir is the root dir
                // Using fs.mkdir() on the root directory even with recursion will result in an error
                if (! (fs.existsSync(fullOutDir) && fs.statSync(fullOutDir).isDirectory())) {
                    fs.mkdirSync(fullOutDir, { recursive: true })
                }
            })
            this.buildInitiator(rootFile, languageId, recipeName, releaseBuildMutex)
        } catch (e) {
            this.extension.logger.addLogMessage('Unexpected Error: please see the console log of the Developer Tools of VS Code.')
            this.extension.logger.displayStatus('x', 'errorForeground')
            releaseBuildMutex()
            throw(e)
        }
    }

    private progressString(recipeName: string, steps: StepCommand[], index: number) {
        if (steps.length < 2) {
            return recipeName
        } else {
            return recipeName + `: ${index + 1}/${steps.length} (${steps[index].name})`
        }
    }

    private buildStep(rootFile: string, steps: StepCommand[], index: number, recipeName: string, releaseBuildMutex: () => void) {
        if (index === 0) {
            this.extension.logger.clearCompilerMessage()
        }
        if (index > 0) {
            const configuration = vscode.workspace.getConfiguration('latex-workshop')
            if (configuration.get('latex.build.clearLog.everyRecipeStep.enabled')) {
                this.extension.logger.clearCompilerMessage()
            }
        }
        this.extension.logger.displayStatus('sync~spin', 'statusBar.foreground', undefined, undefined, ` ${this.progressString(recipeName, steps, index)}`)
        this.extension.logger.addLogMessage(`Recipe step ${index + 1}: ${steps[index].command}, ${steps[index].args}`)
        this.extension.logger.addLogMessage(`Recipe step env: ${JSON.stringify(steps[index].env)}`)
        const envVars = Object.create(null) as ProcessEnv
        Object.keys(process.env).forEach(key => envVars[key] = process.env[key])
        const currentEnv = steps[index].env
        if (currentEnv) {
            Object.keys(currentEnv).forEach(key => envVars[key] = currentEnv[key])
        }
        // We log $Path too since `Object.keys(process.env)` includes Path, not PATH on Windows.
        const envVarsPATH = envVars['PATH']
        const envVarsPath = envVars['Path']
        envVars['max_print_line'] = maxPrintLine
        if (steps[index].name === texMagicProgramName || steps[index].name === bibMagicProgramName) {
            // All optional arguments are given as a unique string (% !TeX options) if any, so we use {shell: true}
            let command = steps[index].command
            const args = steps[index].args
            if (args) {
                command += ' ' + args[0]
            }
            this.extension.logger.addLogMessage(`cwd: ${path.dirname(rootFile)}`)
            this.currentProcess = cs.spawn(command, [], {cwd: path.dirname(rootFile), env: envVars, shell: true})
        } else {
            let workingDirectory: string
            if (steps[index].command === 'latexmk' && rootFile === this.extension.manager.localRootFile && this.extension.manager.rootDir) {
                workingDirectory = this.extension.manager.rootDir
            } else {
                workingDirectory = path.dirname(rootFile)
            }
            this.extension.logger.addLogMessage(`cwd: ${workingDirectory}`)
            this.currentProcess = cs.spawn(steps[index].command, steps[index].args, {cwd: workingDirectory, env: envVars})
        }
        const pid = this.currentProcess.pid
        this.extension.logger.addLogMessage(`LaTeX build process spawned. PID: ${pid}.`)

        let stdout = ''
        this.currentProcess.stdout.on('data', (newStdout: Buffer | string) => {
            stdout += newStdout
            this.extension.logger.addCompilerMessage(newStdout.toString())
        })

        let stderr = ''
        this.currentProcess.stderr.on('data', (newStderr: Buffer | string) => {
            stderr += newStderr
            this.extension.logger.addCompilerMessage(newStderr.toString())
        })

        this.currentProcess.on('error', err => {
            this.extension.logger.addLogMessage(`LaTeX fatal error: ${err.message}, ${stderr}. PID: ${pid}.`)
            this.extension.logger.addLogMessage(`Does the executable exist? $PATH: ${envVarsPATH}`)
            this.extension.logger.addLogMessage(`Does the executable exist? $Path: ${envVarsPath}`)
            this.extension.logger.addLogMessage(`The environment variable $SHELL: ${process.env.SHELL}`)
            this.extension.logger.displayStatus('x', 'errorForeground', undefined, 'error')
            void this.extension.logger.showErrorMessageWithExtensionLogButton(`Recipe terminated with fatal error: ${err.message}.`)
            this.currentProcess = undefined
            releaseBuildMutex()
        })

        this.currentProcess.on('exit', async (exitCode, signal) => {
            this.extension.compilerLogParser.parse(stdout, rootFile)
            if (exitCode !== 0) {
                this.extension.logger.addLogMessage(`Recipe returns with error: ${exitCode}/${signal}. PID: ${pid}. message: ${stderr}.`)
                this.extension.logger.addLogMessage(`The environment variable $PATH: ${envVarsPATH}`)
                this.extension.logger.addLogMessage(`The environment variable $Path: ${envVarsPath}`)
                this.extension.logger.addLogMessage(`The environment variable $SHELL: ${process.env.SHELL}`)

                const configuration = vscode.workspace.getConfiguration('latex-workshop')
                if (!this.disableCleanAndRetry && configuration.get('latex.autoBuild.cleanAndRetry.enabled')) {
                    this.disableCleanAndRetry = true
                    if (signal !== 'SIGTERM') {
                        this.extension.logger.displayStatus('x', 'errorForeground', 'Recipe terminated with error. Retry building the project.', 'warning')
                        this.extension.logger.addLogMessage('Cleaning auxiliary files and retrying build after toolchain error.')

                        void this.extension.cleaner.clean(rootFile).then(() => {
                            this.buildStep(rootFile, steps, 0, recipeName, releaseBuildMutex)
                        })
                    } else {
                        this.extension.logger.displayStatus('x', 'errorForeground')
                        this.currentProcess = undefined
                        releaseBuildMutex()
                    }
                } else {
                    this.extension.logger.displayStatus('x', 'errorForeground')
                    if (['onFailed', 'onBuilt'].includes(configuration.get('latex.autoClean.run') as string)) {
                        await this.extension.cleaner.clean(rootFile)
                    }
                    void this.extension.logger.showErrorMessageWithCompilerLogButton('Recipe terminated with error.')
                    this.currentProcess = undefined
                    releaseBuildMutex()
                }
            } else {
                if (index === steps.length - 1) {
                    this.extension.logger.addLogMessage(`Recipe of length ${steps.length} finished. PID: ${pid}.`)
                    try {
                        await this.buildFinished(rootFile)
                    } finally {
                        this.currentProcess = undefined
                        releaseBuildMutex()
                    }
                } else {
                    this.extension.logger.addLogMessage(`A step in recipe finished. PID: ${pid}.`)
                    this.buildStep(rootFile, steps, index + 1, recipeName, releaseBuildMutex)
                }
            }
        })
    }

    private async buildFinished(rootFile: string) {
        this.extension.logger.addLogMessage(`Successfully built ${rootFile}.`)
        this.extension.logger.displayStatus('check', 'statusBar.foreground', 'Recipe succeeded.')
        if (this.extension.compilerLogParser.isLaTeXmkSkipped) {
            return
        }
        this.extension.viewer.refreshExistingViewer(rootFile)
        this.extension.completer.reference.setNumbersFromAuxFile(rootFile)
        await this.extension.manager.parseFlsFile(rootFile)
        const configuration = vscode.workspace.getConfiguration('latex-workshop')
        // If the PDF viewer is internal, we call SyncTeX in src/components/viewer.ts.
        if (configuration.get('view.pdf.viewer') === 'external' && configuration.get('synctex.afterBuild.enabled')) {
            const pdfFile = this.extension.manager.tex2pdf(rootFile)
            this.extension.logger.addLogMessage('SyncTex after build invoked.')
            this.extension.locator.syncTeX(undefined, undefined, pdfFile)
        }
        if (configuration.get('latex.autoClean.run') as string === 'onBuilt') {
            this.extension.logger.addLogMessage('Auto Clean invoked.')
            await this.extension.cleaner.clean(rootFile)
        }
    }

    private createSteps(rootFile: string, languageId: string, recipeName: string | undefined): StepCommand[] | undefined {
        let steps: StepCommand[] = []
        const configuration = vscode.workspace.getConfiguration('latex-workshop')

        const [magicTex, magicBib] = this.findProgramMagic(rootFile)
        if (recipeName === undefined && magicTex && !configuration.get('latex.build.forceRecipeUsage')) {
            if (! magicTex.args) {
                magicTex.args = configuration.get('latex.magic.args') as string[]
                magicTex.name = texMagicProgramName + 'WithArgs'
            }
            if (magicBib) {
                if (! magicBib.args) {
                    magicBib.args = configuration.get('latex.magic.bib.args') as string[]
                    magicBib.name = bibMagicProgramName + 'WithArgs'
                }
                steps = [magicTex, magicBib, magicTex, magicTex]
            } else {
                steps = [magicTex]
            }
        } else {
            const recipes = configuration.get('latex.recipes') as Recipe[]
            const defaultRecipeName = configuration.get('latex.recipe.default') as string
            const tools = configuration.get('latex.tools') as StepCommand[]
            if (recipes.length < 1) {
                this.extension.logger.addLogMessage('No recipes defined.')
                void this.extension.logger.showErrorMessage('No recipes defined.')
                return undefined
            }
            let recipe: Recipe | undefined = undefined
            if (this.previousLanguageId !== languageId) {
                this.previouslyUsedRecipe = undefined
            }
            if (!recipeName && ! ['first', 'lastUsed'].includes(defaultRecipeName)) {
                recipeName = defaultRecipeName
            }
            if (recipeName) {
                const candidates = recipes.filter(candidate => candidate.name === recipeName)
                if (candidates.length < 1) {
                    this.extension.logger.addLogMessage(`Failed to resolve build recipe: ${recipeName}`)
                    void this.extension.logger.showErrorMessage(`Failed to resolve build recipe: ${recipeName}`)
                }
                recipe = candidates[0]
            }
            if (recipe === undefined) {
                if (defaultRecipeName === 'lastUsed') {
                    recipe = this.previouslyUsedRecipe
                }
                if (defaultRecipeName === 'first' || recipe === undefined) {
                   let candidates: Recipe[] = recipes
                   if (languageId === 'rsweave') {
                        candidates = recipes.filter(candidate => candidate.name.toLowerCase().match('rnw|rsweave'))
                   } else if (languageId === 'jlweave') {
                        candidates = recipes.filter(candidate => candidate.name.toLowerCase().match('jnw|jlweave|weave.jl'))
                   }
                    if (candidates.length < 1) {
                        this.extension.logger.addLogMessage(`Failed to resolve build recipe: ${recipeName}`)
                        void this.extension.logger.showErrorMessage(`Failed to resolve build recipe: ${recipeName}`)
                    }
                    recipe = candidates[0]
                }
            }
            if (recipe === undefined) {
                return undefined
            }
            this.previouslyUsedRecipe = recipe
            this.previousLanguageId = languageId

            recipe.tools.forEach(tool => {
                if (typeof tool === 'string') {
                    const candidates = tools.filter(candidate => candidate.name === tool)
                    if (candidates.length < 1) {
                        this.extension.logger.addLogMessage(`Skipping undefined tool: ${tool} in ${recipe?.name}`)
                        void this.extension.logger.showErrorMessage(`Skipping undefined tool "${tool}" in recipe "${recipe?.name}."`)
                    } else {
                        steps.push(candidates[0])
                    }
                } else {
                    steps.push(tool)
                }
            })
        }
        /**
         * Use JSON.parse and JSON.stringify for a deep copy.
         */
        steps = JSON.parse(JSON.stringify(steps)) as StepCommand[]

        const docker = configuration.get('docker.enabled')
        steps.forEach(step => {
            if (docker) {
                switch (step.command) {
                    case 'latexmk':
                        this.extension.logger.addLogMessage('Use Docker to invoke the command.')
                        if (process.platform === 'win32') {
                            step.command = path.resolve(this.extension.extensionRoot, './scripts/latexmk.bat')
                        } else {
                            step.command = path.resolve(this.extension.extensionRoot, './scripts/latexmk')
                            fs.chmodSync(step.command, 0o755)
                        }
                        break
                    default:
                        this.extension.logger.addLogMessage(`Will not use Docker to invoke the command: ${step.command}`)
                        break
                }
            }
            if (step.args) {
                step.args = step.args.map(replaceArgumentPlaceholders(rootFile, this.tmpDir))
            }
            if (step.env) {
                Object.keys(step.env).forEach( v => {
                    const e = step.env && step.env[v]
                    if (step.env && e) {
                        step.env[v] = replaceArgumentPlaceholders(rootFile, this.tmpDir)(e)
                    }
                })
            }
            if (configuration.get('latex.option.maxPrintLine.enabled')) {
                if (!step.args) {
                    step.args = []
                }
                const isLuaLatex = step.args.includes('-lualatex') ||
                                   step.args.includes('-pdflua') ||
                                   step.args.includes('-pdflualatex') ||
                                   step.args.includes('--lualatex') ||
                                   step.args.includes('--pdflua') ||
                                   step.args.includes('--pdflualatex')
                if (this.isMiktex && ((step.command === 'latexmk' && !isLuaLatex) || step.command === 'pdflatex')) {
                    step.args.unshift('--max-print-line=' + maxPrintLine)
                }
            }
        })
        return steps
    }

    private findProgramMagic(rootFile: string): [StepCommand | undefined, StepCommand | undefined] {
        const regexTex = /^(?:%\s*!\s*T[Ee]X\s(?:TS-)?program\s*=\s*([^\s]*)$)/m
        const regexBib = /^(?:%\s*!\s*BIB\s(?:TS-)?program\s*=\s*([^\s]*)$)/m
        const regexTexOptions = /^(?:%\s*!\s*T[Ee]X\s(?:TS-)?options\s*=\s*(.*)$)/m
        const regexBibOptions = /^(?:%\s*!\s*BIB\s(?:TS-)?options\s*=\s*(.*)$)/m
        const content = fs.readFileSync(rootFile).toString()

        const tex = content.match(regexTex)
        const bib = content.match(regexBib)
        let texCommand: StepCommand | undefined = undefined
        let bibCommand: StepCommand | undefined = undefined

        if (tex) {
            texCommand = {
                name: texMagicProgramName,
                command: tex[1]
            }
            this.extension.logger.addLogMessage(`Found TeX program by magic comment: ${texCommand.command}`)
            const res = content.match(regexTexOptions)
            if (res) {
                texCommand.args = [res[1]]
                this.extension.logger.addLogMessage(`Found TeX options by magic comment: ${texCommand.args}`)
            }
        }

        if (bib) {
            bibCommand = {
                name: bibMagicProgramName,
                command: bib[1]
            }
            this.extension.logger.addLogMessage(`Found BIB program by magic comment: ${bibCommand.command}`)
            const res = content.match(regexBibOptions)
            if (res) {
                bibCommand.args = [res[1]]
                this.extension.logger.addLogMessage(`Found BIB options by magic comment: ${bibCommand.args}`)
            }
        }

        return [texCommand, bibCommand]
    }
}

interface ProcessEnv {
    [key: string]: string | undefined
}

interface StepCommand {
    name: string,
    command: string,
    args?: string[],
    env?: ProcessEnv
}

interface Recipe {
    name: string,
    tools: (string | StepCommand)[]
}
