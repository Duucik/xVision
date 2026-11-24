const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectVideo: () => ipcRenderer.invoke('select-video'),
  selectOutputFolder: () => ipcRenderer.invoke('select-output-folder'),
  exportClips: (payload) => ipcRenderer.invoke('export-clips', payload),
  videoInfo: (payload) => ipcRenderer.invoke('video-info', payload),
  onExportProgress: (callback) => {
    ipcRenderer.removeAllListeners('export-progress');
    ipcRenderer.on('export-progress', (event, msg) => callback(msg));
  },
  getSettings: () => ipcRenderer.invoke('get-settings'),
  onUiZoom: (callback) => {
    ipcRenderer.removeAllListeners('ui-zoom');
    ipcRenderer.on('ui-zoom', (event, msg) => callback(msg));
  },
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  selectProjectsFolder: () => ipcRenderer.invoke('select-projects-folder'),
  loadProjectForVideo: (payload) => ipcRenderer.invoke('load-project-for-video', payload),
  saveProject: (payload) => ipcRenderer.invoke('save-project', payload),
  saveProjectSync: (payload) => ipcRenderer.sendSync('save-project-sync', payload),
  listProjects: (payload) => ipcRenderer.invoke('list-projects', payload),
  readProjectFile: (payload) => ipcRenderer.invoke('read-project-file', payload),
  deleteProject: (payload) => ipcRenderer.invoke('delete-project', payload),
  videoExists: (payload) => ipcRenderer.invoke('video-exists', payload),
  selectDownloadsFolder: () => ipcRenderer.invoke('select-downloads-folder'),
  downloadVideo: (payload) => ipcRenderer.invoke('download-video', payload),
  cancelDownload: () => ipcRenderer.invoke('download-cancel'),
  pickLoader: () => ipcRenderer.invoke('loader-pick'),
  onDownloadProgress: (callback) => {
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.on('download-progress', (event, msg) => callback(msg));
  },
  aiStatus: () => ipcRenderer.invoke('ai-status'),
  aiPrepare: () => ipcRenderer.invoke('ai-prepare'),
  aiDetect: (payload) => ipcRenderer.invoke('ai-detect', payload),
  aiTrack: (payload) => ipcRenderer.invoke('ai-track', payload),
  aiCancel: () => ipcRenderer.invoke('ai-cancel'),
  aiReport: () => ipcRenderer.invoke('ai-report'),
  licenseInfo: () => ipcRenderer.invoke('license-info'),
  licenseActivate: (key) => ipcRenderer.invoke('license-activate', key),
  licenseContinue: () => ipcRenderer.invoke('license-continue'),
  licenseOpen: () => ipcRenderer.invoke('license-open'),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', text),
  updateInfo: () => ipcRenderer.invoke('update-info'),
  updateNotes: () => ipcRenderer.invoke('update-notes'),
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  updateBeta: (on) => ipcRenderer.invoke('update-beta', on),
  onUpdateStatus: (callback) => {
    ipcRenderer.removeAllListeners('update-status');
    ipcRenderer.on('update-status', (event, msg) => callback(msg));
  },
  posCut: (payload) => ipcRenderer.invoke('pos-cut', payload),
  onPosProgress: (cb) => { ipcRenderer.removeAllListeners('pos-progress'); ipcRenderer.on('pos-progress', (_e, d) => cb(d)); },
  selectVideos: () => ipcRenderer.invoke('select-videos'),
  mergeVideos: (payload) => ipcRenderer.invoke('merge-videos', payload),
  mergeCancel: () => ipcRenderer.invoke('merge-cancel'),
  onMergeProgress: (callback) => {
    ipcRenderer.removeAllListeners('merge-progress');
    ipcRenderer.on('merge-progress', (event, msg) => callback(msg));
  },
  onAiProgress: (callback) => {
    ipcRenderer.removeAllListeners('ai-progress');
    ipcRenderer.on('ai-progress', (event, msg) => callback(msg));
  },
  // Тренерская
  coachLoad: () => ipcRenderer.invoke('coach-load'),
  coachSave: (lib) => ipcRenderer.invoke('coach-save', lib),
  coachPdf: (payload) => ipcRenderer.invoke('coach-pdf', payload),
  coachPrint: (payload) => ipcRenderer.invoke('coach-print', payload),
  coachSavePng: (payload) => ipcRenderer.invoke('coach-save-png', payload),
  coachExport: (payload) => ipcRenderer.invoke('coach-export', payload),
  coachShowFile: (p) => ipcRenderer.invoke('coach-show-file', p),
  coachFindOld: () => ipcRenderer.invoke('coach-find-old'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },
});
