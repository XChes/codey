import { contextBridge, ipcRenderer } from "electron";
import { createDesktopBridge } from "./bridge";

const bridge = createDesktopBridge((channel, ...args) =>
  ipcRenderer.invoke(channel, ...args),
  (channel, listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void =>
      listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
);

contextBridge.exposeInMainWorld("desktop", bridge);
