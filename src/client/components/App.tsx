import * as React from 'react';
import { StyleSheet, css } from 'aphrodite';
import debounce from 'lodash/debounce';
import isString from 'lodash/isString';
import isBoolean from 'lodash/isBoolean';
import BroadcastChannel from 'broadcast-channel';
import EditorView from './EditorView';
import updateEntry from '../actions/updateEntry';
import AnimatedLogo from './shared/AnimatedLogo';
import { LaTeXEngine, CompileResult } from '../swiftlatex/latexEngine';
import { loadWASM } from 'onigasm'; // peer dependency of 'monaco-textmate'
import JSZip from 'jszip';
import { arrayBufferToJson, arrayBufferToString, isImageFile, isOpenTypeFontFile } from '../utils/fileUtilities';
import { initializeStorage, BackendStorage } from '../storage/index';


import {
    Annotation,
    FileSystemEntry,
    SaveStatus,
} from '../types';



const BROADCAST_CHANNEL_NAME = 'SWIFTLATEX_BROADCAST_CHANNEL';

enum SessionStatus {
    LoadComponents,
    LoadFiles,
    Ready,
    LoadComponentsFailed,
    LoadFilesFailed
}

type State = {
    id: string;
    username: string;
    name: string;
    isSaved: boolean;
    isSystemBusy: boolean;
    sessionStatus: SessionStatus;
    sendCodeOnChangeEnabled: boolean;
    autosaveEnabled: boolean;
    saveStatus: SaveStatus;
    fileEntries: FileSystemEntry[];
    engineErrors: Annotation[] | undefined;
    engineLogs: string;
    entryPoint: string;
};


export default class App extends React.Component<any, State> {
    constructor(props: any) {
        super(props);
        this.state = {
            id: '',
            username: '',
            name: '',
            isSaved: false,
            isSystemBusy: false,
            sessionStatus: SessionStatus.LoadComponents,
            sendCodeOnChangeEnabled: true,
            autosaveEnabled: true,
            saveStatus: 'changed',
            fileEntries: [],
            engineLogs: '',
            engineErrors: undefined,
            entryPoint: 'main.tex',
        };
    }

    componentDidMount() {
        const urlParams = new URLSearchParams(window.location.search);
        const project_id = urlParams.get('p');

        if (!project_id) {
            this.setState({ sessionStatus: SessionStatus.LoadFilesFailed });
        } else {
            this.setState({ 'id': project_id });
        }

        this._initSession().then();

        this._broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME, {
            webWorkerSupport: false,
        });

        // Let other tabs know that a new tab is opened
        this._broadcastChannel.postMessage({
            type: 'NEW_TAB',
            id: project_id,
        }).then();

        // Listen to messages from other tabs
        this._broadcastChannel.addEventListener('message', e => {
            // Only respond to messages which have the same snack
            if (!e.id || e.id !== project_id) {
                return;
            }

            switch (e.type) {
                case 'NEW_TAB':
                    this._broadcastChannel.postMessage({
                        type: 'DUPLICATE_TAB',
                        id: project_id,
                    });
                    break;
                case 'DUPLICATE_TAB':
                    alert('Warning: another tab with the same project is opened!');
                    window.close();
                    break;
            }
        });
    }

    _latexEngine: LaTeXEngine = undefined as any;
    _backendStorage: BackendStorage | undefined = undefined;

    async _loadEditorComponents() {
        try {
            await new Promise((resolve, reject) => {
                loadWASM('bin/onigasm.wasm').then(
                    function() {
                        resolve();
                    },
                    function() {
                        reject();
                    },
                );
            });
            this._latexEngine = new LaTeXEngine();
            await this._latexEngine.loadEngine();
            return true;
        } catch (e) {
            return false;
        }
    }

    async _loadProjectFiles() {
        try {
            const manifest_buffer = await this._backendStorage!.get('manifest', this.state.id);
            const manifest = arrayBufferToJson(manifest_buffer);
            const username = manifest['username'];
            const name = manifest['name'];
            let entryPoint = manifest['entryPoint'];
            const fileEntries = manifest['fileEntries'];
            if (!username || !name || !entryPoint || !fileEntries) {
                return false;
            }

            if (!Array.isArray(fileEntries)) {
                return false;
            }

            const importedEntries: FileSystemEntry[] = [];
            let entryPointFound = false;
            for (let j = 0; j < fileEntries.length; j++) {
                const tmp = fileEntries[j];
                if (!isString(tmp.type) || !isString(tmp.id) || !isString(tmp.path) || !isString(tmp.uri) || !isString(tmp.content) || !isBoolean(tmp.asset)) {
                    return false;
                }

                let importedEntry: FileSystemEntry = {
                    item: {
                        type: tmp.type,
                        asset: tmp.asset,
                        uri: tmp.uri,
                        content: '',
                        id: tmp.id,
                        path: tmp.path,
                    },
                    state: {},
                };


                if (tmp.type === 'file') {
                    try {
                        if (!tmp.asset) { /* Is a text file */
                            const tmp_content_buf = await this._backendStorage!.get('asset', tmp.id);
                            importedEntry.item.content = arrayBufferToString(tmp_content_buf);
                            if(tmp.path === entryPoint) {
                                importedEntry.state = {
                                    isOpen: true,
                                    isFocused: true,
                                }
                                entryPointFound = true;
                            }
                        } else if (isImageFile(tmp.path)) {
                            importedEntry.item.content = tmp.content;
                            /* Do nothing, as content contains the measurement already */
                        } else if (isOpenTypeFontFile(tmp.path)) {
                            const tmp_content_buf = await this._backendStorage!.get('asset', tmp.id);
                            importedEntry.item.content = tmp_content_buf;
                        }
                    } catch (e) {
                        console.error('Failed to load ' + tmp.path);
                        continue;
                    }
                }
                importedEntries.push(importedEntry);
            }

            if (!entryPointFound) {
                entryPoint = '';
            }

            this.setState({
                username: username,
                name: name,
                fileEntries: importedEntries,
                entryPoint: entryPoint,
            });

            return true;
        } catch (e) {
            return false;
        }
    }

    async _initSession() {
        /* Load Components */
        this._backendStorage = initializeStorage();

        if (!this._backendStorage) {
            this.setState({
                sessionStatus: SessionStatus.LoadComponentsFailed,
            });
            return;
        }

        if (await this._loadEditorComponents()) {
            this.setState({
                sessionStatus: SessionStatus.LoadFiles,
            });
            if (await this._loadProjectFiles()) {
                this.setState({
                    sessionStatus: SessionStatus.Ready,
                });
            } else {
                this.setState({
                    sessionStatus: SessionStatus.LoadFilesFailed,
                });
            }
        } else {
            this.setState({
                sessionStatus: SessionStatus.LoadComponentsFailed,
            });
        }
    }


    _compareFileTreeStructure(
        nextFileEntries: FileSystemEntry[],
        originalFileEntries: FileSystemEntry[],
    ) {

        if (originalFileEntries.length !== nextFileEntries.length) {
            return true;
        } else {
            for (let i = 0; i < nextFileEntries.length; i++) {
                if (
                    nextFileEntries[i].item.type !== originalFileEntries[i].item.type ||
                    nextFileEntries[i].item.path !== originalFileEntries[i].item.path ||
                    nextFileEntries[i].item.asset !== originalFileEntries[i].item.asset
                ) {
                    return true;
                }
            }
        }
        return false;
    }

    _copyEntryBeforeUpload = (tmp: FileSystemEntry) => {
        const entry = {
            uri: tmp.item.uri,
            content: isImageFile(tmp.item.path) ? tmp.item.content : '', /* We do not need to upload content except for measured images */
            asset: tmp.item.asset,
            type: tmp.item.type,
            path: tmp.item.path,
            id: tmp.item.id,
        };
        return entry;
    };

    _uploadFileTree = async () => {
        /* This function uploads all modified files and generate a manifest file for project infos */
        let currentStateEntries = this.state.fileEntries;
        const fileEntriesCopy = [];

        for (let j = 0; j < currentStateEntries.length; j++) {
            const tmp = currentStateEntries[j];
            const copyTmp = this._copyEntryBeforeUpload(tmp);
            /* Handle upload modified code files */
            if (tmp.item.type === 'file') {
                if (!tmp.item.asset) {
                    let needUpload = false;
                    if (tmp.item.uri === '') { /* Without a url, always need to upload */
                        needUpload = true;
                    } else { /* Not empty uri, we need to compare and see whether it changes or not */
                        if (this._requiredUploadFiles.includes(tmp.item.id)) {
                            needUpload = true;
                        }
                    }
                    if (needUpload) {
                        console.log('Uploading ' + tmp.item.path);
                        const theBlob = new Blob([tmp.item.content], { type: 'text/tex' });
                        try {
                            const remoteUrl = await this._backendStorage!.put('asset', tmp.item.id, theBlob);
                            copyTmp.uri = remoteUrl;
                            if (remoteUrl !== tmp.item.uri) {
                                this.setState((state: State) => ({
                                    fileEntries: state.fileEntries.map(entry => {
                                        if (entry.item.path === tmp.item.path) {
                                            return updateEntry(entry, { item: { uri: remoteUrl } });
                                        }
                                        return entry;
                                    }),
                                }));
                            }
                        } catch (e) {
                            console.log('An upload error is detected, silently ignored?' + tmp.item.path);
                        }
                    }
                }
            }
            fileEntriesCopy.push(copyTmp);
        }
        this._requiredUploadFiles = [];
        return fileEntriesCopy;
    };


    _requiredFlushInEngine = true;
    _requiredUpdateFilesInEngine: string[] = [];
    _requiredUploadFiles: string[] = [];

    componentDidUpdate(_: any, __: State) {
        if (this.state.sessionStatus !== SessionStatus.Ready) {
            return;
        }

        if (this.state.isSystemBusy) {
            return;
        }

        if (this.state.sendCodeOnChangeEnabled) {
            if (this.state.fileEntries.length === 0 || !this.state.entryPoint) {
                return;
            }
            if (this._requiredFlushInEngine || this._requiredUpdateFilesInEngine.length > 0) {
                this._fireEngine();
            }
        }

        if (this.state.saveStatus !== 'published') {
            // /* This part is for sync manifest */
            this._syncManifest();
        }
    }

    componentWillUnmount() {
        this._latexEngine && this._latexEngine.closeWorker();

        this._broadcastChannel.close().then();
    }

    _previewRef = React.createRef<Window>();

    _broadcastChannel: BroadcastChannel = undefined as any;

    _handleToggleSendCode = () =>
        this.setState(state => ({ sendCodeOnChangeEnabled: !state.sendCodeOnChangeEnabled }));

    _handleSubmitTitle = async (name: string) => {
        this.setState({name: name, saveStatus: 'changed'});
    }


    _syncManifestNoDebounce = async () => {
        const fileEntriesCopy = await this._uploadFileTree();
        const manifest = {
            name: this.state.name,
            entryPoint: this.state.entryPoint,
            username: this.state.username,
            modifiedTime: new Date().toString(),
            fileEntries: fileEntriesCopy,
        };
        const jsonStr = JSON.stringify(manifest);
        // console.log(jsonStr);
        const manifestBlob = new Blob([jsonStr]);
        try {
            await this._backendStorage!.put('manifest', this.state.id, manifestBlob);
        } catch (e) {
            console.log('Unable to upload manifest!');
        }

        this.setState({ saveStatus: 'published' });
    };

    _syncManifest = debounce(this._syncManifestNoDebounce, 1000);


    _reloadSnack = () => {
        // this._snack.session.reloadSnack();
    };

    _handleChangeCursor = (path: string, line: number, column: number) => {
        const preview = this._previewRef.current;
        if (preview) {
            preview.postMessage({ cmd: 'setCursor', path: path, line: line, column: column }, '*');
        }
    };

    _generateResourceUrlMap = () => {
        const resourceMap: any = {};
        for (let i = 0; i < this.state.fileEntries.length; i++) {
            const entry = this.state.fileEntries[i];
            if (entry.item.asset) {
                resourceMap[entry.item.path] = entry.item.uri;
            }
        }
        return resourceMap;
    };

    _fireEngineDebounce = async () => {
        if (!this._latexEngine.isReady()) return;
        const currentFileEntries = this.state.fileEntries;

        if (this._requiredFlushInEngine) {

            this._latexEngine.flushCache();
            for (let j = 0; j < currentFileEntries.length; j++) {
                const tmp = currentFileEntries[j];
                if (tmp.item.type === 'folder') {
                    console.log('Make fresh dir ' + tmp.item.path);
                    this._latexEngine.makeMemFSFolder(tmp.item.path);
                }
            }
            for (let j = 0; j < currentFileEntries.length; j++) {
                const tmp = currentFileEntries[j];
                if (tmp.item.type === 'file') {
                    console.log('Write fresh file ' + tmp.item.path);
                    this._latexEngine.writeMemFSFile(tmp.item.path, tmp.item.content);
                }
            }
        } else {
            for (let j = 0; j < currentFileEntries.length; j++) {
                const tmp = currentFileEntries[j];
                if (this._requiredUpdateFilesInEngine.includes(tmp.item.path)) {
                    console.log('Update modified file ' + tmp.item.path);
                    this._latexEngine.writeMemFSFile(tmp.item.path, tmp.item.content);
                }
            }
        }
        this._requiredFlushInEngine = false;
        this._requiredUpdateFilesInEngine = [];

        this._latexEngine.setEngineMainFile(this.state.entryPoint);
        this.setState({ isSystemBusy: true });
        const preview = this._previewRef.current;
        if (preview) {
            preview.postMessage({ cmd: 'compileStart' }, '*');
        }
        const r: CompileResult = await this._latexEngine.compileLaTeX();
        if (preview) {
            preview.postMessage({ cmd: 'compileEnd' }, '*');
        }
        this.setState({ isSystemBusy: false, engineLogs: r.log, engineErrors: r.errors });
        if (r.pdf) {
            if (preview) {
                const content = new TextDecoder('utf-8').decode(r.pdf);
                preview.postMessage({
                    cmd: 'setContent',
                    source: content,
                    resources: this._generateResourceUrlMap(),
                }, '*');
            }
        } else {
            if (preview) {
                preview.postMessage({ cmd: 'compileError' }, '*');
            }
        }
    };

    _fireEngine = debounce(this._fireEngineDebounce, 1000);

    _handleOnSendCode = () => {
        if (this.state.entryPoint) {
            this._requiredUpdateFilesInEngine.push(this.state.entryPoint);
            this.setState({saveStatus: 'changed'});
        }
    }

    _handleTypeContent = (delta: string, isInsert: boolean) => {
        const preview = this._previewRef.current;
        if (preview) {
            preview.postMessage({ cmd: 'typeContent', delta: delta, isInsert: isInsert }, '*');
        }
    };

    _handleChangeCode = (content: string, path: string) => {
        this.setState((state: State) => ({
            saveStatus: 'changed',
            fileEntries: state.fileEntries.map(entry => {
                if (entry.item.type === 'file' && !entry.item.asset && entry.item.path === path && entry.state.isFocused === true) {
                    if (!this._requiredUpdateFilesInEngine.includes(path)) {
                        this._requiredUpdateFilesInEngine.push(path);
                    }
                    if (!this._requiredUploadFiles.includes(entry.item.id)) {
                        this._requiredUploadFiles.push(entry.item.id);
                    }
                    return updateEntry(entry, { item: { content } });
                }
                return entry;
            }),
            engineErrors: undefined,
        }));

    };


    _handleFileEntriesChange = (nextFileEntries: FileSystemEntry[]): Promise<void> => {
        return new Promise(resolve => {
                let fileStructureChanged = this._compareFileTreeStructure(this.state.fileEntries, nextFileEntries);
                if (fileStructureChanged) {
                    this._requiredFlushInEngine = true;
                    this.setState({ saveStatus: 'changed' });
                }
                this.setState(_ => {
                    return { fileEntries: nextFileEntries };
                }, resolve);
            },
        );
    };

    _handleClearDeviceLogs = () =>
        this.setState({
            engineLogs: '',
        });

    _handleDownloadAsync = async () => {
        // Already check if Snack is saved in EditorView.js
        this.setState({ isSystemBusy: true });

        const zipobj = new JSZip();
        for (let j = 0; j < this.state.fileEntries.length; j++) {
            const tmp = this.state.fileEntries[j];
            if (tmp.item.type === 'file') {
                if (tmp.item.asset && tmp.item.uri) {
                    try {
                        const remoteFile = await this._backendStorage!.get('asset', tmp.item.id);
                        zipobj.file(tmp.item.path, remoteFile);
                    } catch (e) {
                        console.error('Unable to get ' + tmp.item.path);
                    }
                } else {
                    zipobj.file(tmp.item.path, tmp.item.content);
                }
            } else if (tmp.item.type === 'folder') {
            }
        }
        const blobFile = await zipobj.generateAsync({ type: 'blob' });
        this._triggerDownloadAction(blobFile, 'export.zip');

        this.setState({ isSystemBusy: false });
    };

    _findFocusedEntry = (entries: FileSystemEntry[]): FileSystemEntry | undefined =>
        // @ts-ignore
        entries.find(({ item, state }) => item.type === 'file' && state.isFocused === true);

    _uploadAssetAsync = async (fileObj: File, id: string) => {
        return this._backendStorage!.put('asset', id, fileObj);
    };

    _handleSetEntryPoint = (path: string) => {
        this._requiredFlushInEngine = true;
        this.setState({ entryPoint: path, saveStatus: 'changed' });
    };

    _triggerDownloadAction = (blob: Blob, name: string) => {
        const tempPDFURL = URL.createObjectURL(blob);
        setTimeout(_ => {
            URL.revokeObjectURL(tempPDFURL);
        }, 30000);
        // Simulate link click to download file
        const element = document.createElement('a');
        if (element && document.body) {
            document.body.appendChild(element);
            element.setAttribute('href', tempPDFURL);
            element.setAttribute('download', name);
            element.style.display = '';
            element.click();
            document.body.removeChild(element);
        }
    };

    _handleExportPDF = async () => {
        if (!this.state.entryPoint || this.state.fileEntries.length === 0 ) {
            return;
        }
        this.setState({ isSystemBusy: true });
        const export_engine = new LaTeXEngine('export');

        await export_engine.loadEngine();
        let currentFileEntries = this.state.fileEntries;
        for (let j = 0; j < currentFileEntries.length; j++) {
            const tmp = currentFileEntries[j];
            if (tmp.item.type === 'folder') {
                console.log('Export: Make fresh dir ' + tmp.item.path);
                export_engine.makeMemFSFolder(tmp.item.path);
            }
        }
        for (let j = 0; j < currentFileEntries.length; j++) {
            const tmp = currentFileEntries[j];
            if (tmp.item.type === 'file') {
                if (!tmp.item.asset) {
                    console.log('Export: Write fresh file ' + tmp.item.path);
                    export_engine.writeMemFSFile(tmp.item.path, tmp.item.content);
                } else {
                    try {
                        const remoteFile = await this._backendStorage!.get('asset', tmp.item.id);
                        export_engine.writeMemFSFile(tmp.item.path, remoteFile);
                    } catch (e) {
                        console.error('Unable to get ' + tmp.item.path);
                    }
                }
            }
        }

        export_engine.setEngineMainFile(this.state.entryPoint);
        let compileOk = true;

        for (let j = 0; j < 3; j++) {
            const r: CompileResult = await export_engine.compileLaTeX();
            if (!r.pdf) {
                compileOk = false;
                this.setState({ engineLogs: r.log, engineErrors: r.errors });
                break;
            }
        }

        if (!compileOk) {
            /* Nothing we can do */
        } else {
            const r: CompileResult = await export_engine.compilePDF();
            if (r.pdf) {
                this._triggerDownloadAction(new Blob([r.pdf]), 'export.pdf');
            } else {
                this.setState({ engineLogs: r.log, engineErrors: r.errors });
            }
        }

        this.setState({ isSystemBusy: false });
        export_engine.closeWorker();
    };

    render() {
        if (this.state.sessionStatus === SessionStatus.Ready) {
            return (
                <EditorView
                    deviceErrors={this.state.engineErrors}
                    engineLogs={this.state.engineLogs}
                    entry={this._findFocusedEntry(this.state.fileEntries)}
                    fileEntries={this.state.fileEntries}
                    isSystemBusy={this.state.isSystemBusy}
                    name={this.state.name}
                    onChangeCode={this._handleChangeCode}
                    onChangeCursor={this._handleChangeCursor}
                    onTypeContent={this._handleTypeContent}
                    onExportPDF={this._handleExportPDF}
                    onClearDeviceLogs={this._handleClearDeviceLogs}
                    onDownloadAsync={this._handleDownloadAsync}
                    onFileEntriesChange={this._handleFileEntriesChange}
                    onSubmitTitle={this._handleSubmitTitle}
                    onSendCode={this._handleOnSendCode}
                    onToggleSendCode={this._handleToggleSendCode}
                    previewRef={this._previewRef}
                    uploadFileAsync={this._uploadAssetAsync}
                    saveStatus={this.state.saveStatus}
                    sendCodeOnChangeEnabled={this.state.sendCodeOnChangeEnabled}
                    entryPoint={this.state.entryPoint}
                    onSetEntryPoint={this._handleSetEntryPoint}
                />
            );
        } else if (this.state.sessionStatus === SessionStatus.LoadComponents || this.state.sessionStatus === SessionStatus.LoadFiles) {

            return (<div className={css(styles.container)}>
                <div className={css(styles.logo)}>
                    <AnimatedLogo/>
                </div>
                <p className={css(styles.loadingText)}>Loading data...</p>
            </div>);
        } else {
            const errorMessage = this.state.sessionStatus === SessionStatus.LoadComponentsFailed ? 'Failed to start LaTeX engine.' : 'Project files you are looking for do not exist!';
            return (<div className={css(styles.container)}>
                <p className={css(styles.loadingText)}>Oops! {errorMessage} </p>
            </div>);
        }
    }
}


const styles = StyleSheet.create({
    container: {
        flexDirection: 'column',
        display: 'flex',
        height: '100%',
        width: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    logo: {
        transform: 'scale(0.5)',
        opacity: 0.9,
    },
    loadingText: {
        marginTop: 0,
        opacity: 0.7,
        fontSize: 18,
    },
});
