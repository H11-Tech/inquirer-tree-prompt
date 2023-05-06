import _ from 'lodash'
import path from 'path'
import chalk from 'chalk'
import figures from 'figures'
import cliCursor from 'cli-cursor'

import { filter, share, map, takeUntil } from 'rxjs/operators/index.js'

import observe from 'inquirer/lib/utils/events.js'
import BasePrompt from 'inquirer/lib/prompts/base.js'
import Paginator from 'inquirer/lib/utils/paginator.js'

export default class TreePrompt extends BasePrompt {
    constructor(questions, rl, answers) {
        super(questions, rl, answers)

        rl.crlfDelay = 1
        rl.escapeCodeTimeout = 1

        this.done = () => {}

        this.firstRender = true

        const tree = typeof this.opt.tree === 'function' ? this.opt.tree : _.cloneDeep(this.opt.tree)

        this.tree = { children: tree }

        this.shownList = []

        this.opt = {
            pageSize: 1000,
            multiple: false,
            ...this.opt,
        }

        // Make sure no default is set (so it won't be printed)
        this.opt.default = null

        this.paginator = new Paginator(this.screen, {
            isInfinite: this.opt.loop !== false,
        })

        this.selectedList = []

        this.searchQuery = ''
        this.isSearchMode = false
    }

    debugLog(...args) {
        console.log('\n'.repeat(Math.ceil(this.opt.pageSize)))
        console.log(...args)
        console.log('\n'.repeat(Math.ceil(this.opt.pageSize)))
    }

    /**
     * @protected
     */
    async _run(done) {
        this.done = done

        this._installKeyHandlers()

        cliCursor.hide()

        await this.prepareChildrenAndRender(this.tree)

        // TODO: exit early somehow if no items
        // TODO: what about if there are no valid items?

        return this
    }

    set searchQuery(query) {
        this.prevSearchQuery = this._searchQuery
        this._searchQuery = query
    }

    get searchQuery() {
        return this._searchQuery
    }

    _installKeyHandlers() {
        this.rl.setMaxListeners(100000)
        this.rl.input.setMaxListeners(100000)
        this.rl.output.setMaxListeners(100000)

        const events = observe(this.rl)

        const validation = this.handleSubmitEvents(
            events.line.pipe(map(() => this.valueFor(this.opt.multiple ? this.selectedList[0] : this.active)))
        )

        validation.success.forEach(this.onSubmit.bind(this))

        validation.error.forEach(this.onError.bind(this))

        events.normalizedUpKey.pipe(takeUntil(validation.success)).forEach(this.onUpKey.bind(this))

        events.normalizedDownKey.pipe(takeUntil(validation.success)).forEach(this.onDownKey.bind(this))

        events.keypress
            .pipe(
                filter(({ key }) => key.name === 'right'),
                share()
            )
            .pipe(takeUntil(validation.success))
            .forEach(this.onRightKey.bind(this))

        events.keypress
            .pipe(
                filter(({ key }) => key.name === 'left'),
                share()
            )
            .pipe(takeUntil(validation.success))
            .forEach(this.onLeftKey.bind(this))

        events.spaceKey.pipe(takeUntil(validation.success)).forEach(this.onSpaceKey.bind(this))

        // ----

        events.keypress
            .pipe(
                filter(({ key }) => this.isSearchMode && (key.name === '\\' || key.sequence === '\\')),
                share()
            )
            .pipe(takeUntil(validation.success))
            .forEach(this.onBackSlashKey.bind(this))

        events.keypress
            .pipe(
                filter(({ key }) => {
                    if (!this.isSearchMode) return false

                    if (key.sequence && !key.name) {
                        key.name = key.sequence
                    }

                    return /^[a-zA-Z0-9\-_/.]$/i.test(key.name)
                }),
                share()
            )
            .pipe(takeUntil(validation.success))
            .forEach(this.onTyping.bind(this))

        events.keypress
            .pipe(
                filter(({ key }) => this.isSearchMode && key.name === 'backspace'),
                share()
            )
            .pipe(takeUntil(validation.success))
            .forEach(this.onBackspaceKey.bind(this))

        events.keypress
            .pipe(
                filter(({ key }) => this.isSearchMode && key.name === 'tab'),
                share()
            )
            .pipe(takeUntil(validation.success))
            .forEach(this.onTabKey.bind(this))

        events.keypress
            .pipe(
                filter(({ key }) => key.name === '/' || key.sequence === '/'),
                share()
            )
            .pipe(takeUntil(validation.success))
            .forEach(this.onForwardSlashKey.bind(this))
    }

    onTabKey() {
        if (!this.isSearchMode) {
            return
        }

        this.searchQuery = this.getPathForNode(this.active)

        if (this.active.children) {
            if (this.searchQuery.endsWith(this.active.name)) {
                this.searchQuery += '/'
            }

            if (this.active.children.length === 1) {
                this.active = this.active.children[0]

                this.onTabKey()

                return
            }
        }

        this.applySearch()
    }

    onBackSlashKey() {
        if (!this.searchQuery) {
            this.isSearchMode = false

            this.searchQuery = ''

            this.applySearch()

            return
        }

        if (this.active.parent !== this.tree) {
            this.active = this.active.parent
        }

        if (this.active.children && this.active.open) {
            this.active.open = false
        }

        this.searchQuery = this.getPathForNode(this.active.parent)

        this.applySearch(false)
    }

    onTyping({ key }) {
        this.searchQuery += key.name

        this.applySearch()
    }

    onBackspaceKey() {
        if (this.searchQuery.length > 0) {
            this.searchQuery = this.searchQuery.slice(0, -1)
        }

        this.applySearch()
    }

    onForwardSlashKey() {
        if (!this.isSearchMode) {
            this.isSearchMode = true
            this.searchQuery = ''
            this.applySearch()
        }
    }

    onUpKey() {
        this.moveActive(-1)
    }

    onDownKey() {
        this.moveActive(1)
    }

    onLeftKey() {
        if (this.active.children && this.active.open) {
            this.active.open = false
        } else if (this.active.parent !== this.tree) {
            this.active = this.active.parent
        }

        this.render()
    }

    onRightKey() {
        if (this.active.children) {
            if (!this.active.open) {
                this.active.open = true

                this.prepareChildrenAndRender(this.active)
            } else if (this.active.children.length) {
                this.moveActive(1)
            }
        }
    }

    onSpaceKey() {
        if (this.opt.multiple) {
            this.toggleSelection()
        } else {
            this.toggleOpen()
        }
    }

    // ---
    onError(state) {
        this.render(state.isValid)
    }

    onSubmit(state) {
        this.status = 'answered'

        this.render()

        this.screen.done()
        cliCursor.show()

        this.done(this.opt.multiple ? this.selectedList.map((item) => this.valueFor(item)) : state.value)
    }

    applySearch() {
        if (this.isSearchMode) {
            const searchQuery = this.searchQuery.toLowerCase()

            const filterNodes = (node) => {
                const nodePath = this.getPathForNode(node)
                const matchesQuery = nodePath ? nodePath.toLowerCase().includes(searchQuery) : false

                if (Array.isArray(node.children)) {
                    node.children.forEach((n) => filterNodes(n))
                }

                if (matchesQuery || !node.children) {
                    node.hidden = false
                } else {
                    node.hidden =
                        !Array.isArray(node.children) || !node.children.some((child) => !child.hidden)
                }
            }

            filterNodes(this.tree)

            const setActive = (node, shouldOpenNext = true) => {
                const isSameNode = this.active && this.active.value === node.value

                // Node is already active and has no children, so do nothing
                if (isSameNode && !this.active.children) return

                this.active = node

                if (this.active.children) {
                    this.active.open = shouldOpenNext

                    this.prepareChildrenAndRender(this.active)
                }
            }

            if (searchQuery && this.queryMatchingNodes.length) {
                const shouldOpenNext = this.prevSearchQuery.length <= searchQuery.length

                setActive(this.queryMatchingNodes[0].node, shouldOpenNext)
            } else if (this.shownList.length === 1) {
                setActive(this.shownList[0])
            } else if (!searchQuery) {
                this.active = this.tree
            } else {
                this.active.open = false
            }
        }

        this.render()
    }

    get queryMatchingNodes() {
        const currentFullQuery = path
            .join(this.opt.rootDirectory, this.searchQuery.toLowerCase())
            .toLowerCase()

        return this.shownList
            .filter((node) => {
                const matchesPathPrefix = node.value.toLowerCase().startsWith(currentFullQuery)

                return matchesPathPrefix
            })
            .map((node) => ({
                node,
                exactMatch: path.relative(node.value.toLowerCase(), currentFullQuery) === '',
            }))
    }

    // ---

    getPathForNode(node) {
        const currPath = []
        let currentNode = node
        while (currentNode.parent) {
            currPath.unshift(this.nameFor(currentNode))
            currentNode = currentNode.parent
        }
        return currPath.join('/')
    }

    async prepareChildrenAndRender(node) {
        await this.prepareChildren(node)

        this.render()
    }

    async prepareChildren(node) {
        if (node.prepared) {
            return
        }
        node.prepared = true

        await this.runChildrenFunctionIfRequired(node)

        if (!node.children) {
            return
        }

        this.cloneAndNormaliseChildren(node)

        await this.validateAndFilterDescendants(node)
    }

    async runChildrenFunctionIfRequired(node) {
        if (typeof node.children === 'function') {
            try {
                const nodeOrChildren = await node.children()
                if (nodeOrChildren) {
                    let children
                    if (Array.isArray(nodeOrChildren)) {
                        children = nodeOrChildren
                    } else {
                        children = nodeOrChildren.children
                        ;['name', 'value', 'short'].forEach((property) => {
                            node[property] = nodeOrChildren[property]
                        })
                        node.isValid = undefined

                        await this.addValidity(node)

                        /*
                         * Don't filter based on validity; children can be handled by the
                         * callback itself if desired, and filtering out the node itself
                         * would be a poor experience in this scenario.
                         */
                    }

                    node.children = _.cloneDeep(children)
                }
            } catch (e) {
                /*
                 * if something goes wrong gathering the children, ignore it;
                 * it could be something like permission denied for a single
                 * directory in a file hierarchy
                 */

                node.children = null
            }
        }
    }

    cloneAndNormaliseChildren(node) {
        node.children = node.children.map((item) => {
            if (typeof item !== 'object') {
                return {
                    value: item,
                }
            }

            return item
        })
    }

    async validateAndFilterDescendants(node) {
        for (let index = node.children.length - 1; index >= 0; index--) {
            const child = node.children[index]

            child.parent = node

            await this.addValidity(child)

            if (this.opt.hideChildrenOfValid && child.isValid === true) {
                child.children = null
            }

            if (this.opt.onlyShowValid && child.isValid !== true && !child.children) {
                node.children.splice(index, 1)
            }

            if (child.open) {
                await this.prepareChildren(child)
            }
        }
    }

    async addValidity(node) {
        if (typeof node.isValid === 'undefined') {
            if (this.opt.validate) {
                node.isValid = await this.opt.validate(this.valueFor(node), this.answers)
            } else {
                node.isValid = true
            }
        }
    }

    render() {
        let message = this.getQuestion()

        if (this.isSearchMode) {
            message += `\nSearch: ${chalk.green('$')} ${chalk.cyan(this.searchQuery)}`
        }

        if (this.firstRender) {
            let hint = 'Use arrow keys,'
            if (this.opt.multiple) {
                hint += ' space to select,'
            }
            hint += ' enter to confirm.'
            message += chalk.dim(`(${hint})`)
        }
        if (this.status === 'answered') {
            let answer

            if (this.opt.multiple) {
                answer = this.selectedList.map((item) => this.shortFor(item, true)).join(', ')
            } else {
                answer = this.shortFor(this.active, true)
            }

            message += chalk.cyan(answer)
        } else {
            this.shownList = []

            let treeContent = this.createTreeContent()

            if (this.opt.loop !== false) {
                treeContent += '----------------'
            }

            message += `\n${this.paginator.paginate(
                treeContent,
                this.shownList.indexOf(this.active),
                this.opt.pageSize
            )}`
        }

        let bottomContent

        if (this.selectedList.length) {
            bottomContent = this.selectedList
                .map((node) => {
                    const nodePath = this.getPathForNode(node)

                    return chalk.blue('>> ') + nodePath
                })
                .join('\n')
        }

        message += `\nSelected Path: ${chalk.green('>> ')} ${chalk.cyan(this.getPathForNode(this.active))}`

        this.firstRender = false
        this.screen.render(message, bottomContent)
    }

    createTreeContent(node = this.tree, indent = 2) {
        let children = node.children || []
        let output = ''

        const isFinal = this.status === 'answered'

        if (typeof children === 'function') {
            children = children()
        }

        children.forEach((child) => {
            if (child.hidden) {
                return
            }

            this.shownList.push(child)

            if (!this.active) {
                this.active = child
            }

            let prefix = '  '

            if (child.children) {
                if (child.open) {
                    prefix = `${figures.arrowDown} `
                } else {
                    prefix = `${figures.arrowRight} `
                }
            } else if (child === this.active) {
                prefix = `${figures.pointer} `
            }

            if (this.opt.multiple) {
                prefix += this.selectedList.includes(child) ? figures.radioOn : figures.radioOff
                prefix += ' '
            }

            const showValue = `${' '.repeat(indent) + prefix + this.nameFor(child, isFinal)}\n`

            if (child === this.active) {
                if (child.isValid === true) {
                    output += chalk.cyan(showValue)
                } else {
                    output += chalk.red(showValue)
                }
            } else {
                output += showValue
            }

            if (child.open) {
                output += this.createTreeContent(child, indent + 2)
            }
        })

        return output
    }

    shortFor(node, isFinal = false) {
        return typeof node.short !== 'undefined' ? node.short : this.nameFor(node, isFinal)
    }

    nameFor(node, isFinal = false) {
        if (typeof node.name !== 'undefined') {
            return node.name
        }

        if (this.opt.transformer) {
            return this.opt.transformer(node.value, this.answers, { isFinal })
        }

        return node.value
    }

    valueFor(node) {
        if (!node) return ''

        return typeof node.value !== 'undefined' ? node.value : node.name
    }

    moveActive(distance = 0) {
        const currentIndex = this.shownList.indexOf(this.active)
        let index = currentIndex + distance

        if (index >= this.shownList.length) {
            if (this.opt.loop === false) {
                return
            }
            index = 0
        } else if (index < 0) {
            if (this.opt.loop === false) {
                return
            }
            index = this.shownList.length - 1
        }

        this.active = this.shownList[index]

        this.render()
    }

    toggleSelection() {
        if (this.active.isValid !== true || this.active.children) {
            return
        }

        const selectedIndex = this.selectedList.indexOf(this.active)

        if (selectedIndex === -1) {
            this.selectedList.push(this.active)
        } else {
            this.selectedList.splice(selectedIndex, 1)
        }

        this.render()
    }

    toggleOpen() {
        if (!this.active.children) {
            return
        }

        this.active.open = !this.active.open

        this.render()
    }
}

/**
 * GPT Explain
 *
 * The TreePrompt class is a custom prompt implementation for Inquirer.js, a popular library for creating command-line interfaces in Node.js applications. This class extends the BasePrompt class from Inquirer.js and provides a tree-like selection interface for the user.
 *
 * Constructor:
 *
 * - The constructor takes three arguments: questions, rl (readline interface), and answers.
 * - It initializes various properties like done, firstRender, tree, shownList, selectedList, and others with default values.
 * - It also sets up the options object by merging the provided options with default values and creates an instance of the Paginator class from Inquirer.js.
 *
 * Methods:
 *
 * - _run(done): This method installs the key handlers, hides the cursor, prepares the tree structure, and renders it. It takes a done callback as a parameter, which is called when the prompt is finished.
 * - _installKeyHandlers(): This method sets up keypress event listeners for different keys like up, down, right, left, space, backspace, tab, and others. It uses the observe function from Inquirer.js to create observables from the readline interface events and then sets up the appropriate keypress handlers using RxJS operators.
 * - onKey: These methods handle the keypress events, such as onUpKey(), onDownKey(), onRightKey(), onLeftKey(), onSpaceKey(), etc. They define the behavior of the prompt when specific keys are pressed, like moving the active selection up or down, expanding or collapsing tree nodes, and others.
 * - prepareChildrenAndRender(node): This method prepares the children nodes of the given node and renders the tree structure. It calls prepareChildren() and render() methods.
 * - prepareChildren(node): This method prepares the child nodes of the given node by running the children function if required, cloning and normalizing the children, and validating and filtering the descendants based on the provided options.
 * - addValidity(node): This method adds the isValid property to the node based on the provided validation function.
 * - render(): This method constructs the message to be displayed on the screen, including the tree structure and the selected path. It uses the createTreeContent() method to build the tree structure and the paginator.paginate() method to handle pagination. It then calls the screen.render() method from Inquirer.js to display the message.
 * - createTreeContent(node, indent): This method recursively builds the tree structure as a string, including the node names, tree node icons, and indentation.
 * - shortFor(node, isFinal): This method returns the short name for the given node, if available, otherwise returns the result of the nameFor() method.
 * - nameFor(node, isFinal): This method returns the name of the given node, applying the provided transformer function if available.
 * - valueFor(node): This method returns the value of the given node, if available, otherwise returns the node's name.
 * - onSubmit(state), onError(state): These methods handle the submission and error events, respectively. onSubmit() sets the prompt status to 'answered', renders the final message, and calls the done() callback with the selected values. onError() renders the error state.
 * - moveActive(distance): This method moves the active selection up or down based on the provided distance value.
 * - toggleSelection(): This method toggles the selection of the active node for multiple selection prompts.
 * - toggleOpen(): This method toggles the open state of the active node, expanding or collapsing it.
 *
 */
