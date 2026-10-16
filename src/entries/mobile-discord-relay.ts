import { DISCORD_LISTENER, startDiscordRelay, type DiscordListener } from "../mobile/discordView";

// Native code's document-start script with its message listener, in an isolated world where the WebView has one (mobile/android, DiscordView.kt).
startDiscordRelay((window as unknown as Record<string, DiscordListener | undefined>)[DISCORD_LISTENER], document, window);
