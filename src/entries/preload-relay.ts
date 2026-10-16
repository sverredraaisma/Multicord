import { ipcRenderer } from "electron";
import { startRelay } from "../preload/relay";

// Nothing is exposed to the relay's page: the sockets live in this preload's own world.
startRelay(ipcRenderer);
