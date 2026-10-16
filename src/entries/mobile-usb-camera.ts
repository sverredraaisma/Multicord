import { installUsbCamera } from "../mobile/usbCamera";

// Native code's document-start script in the page's main world (mobile/android, CameraPort.kt): Discord's page,
// and Multicord's own chat views (https://<instance>.view.multicord.invalid), whose calls have no camera choice
// yet and so take the USB camera when one is attached.
installUsbCamera(window, { prefer: location.hostname.endsWith(".view.multicord.invalid") });
