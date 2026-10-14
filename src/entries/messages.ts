import type { MessagesApi } from "../preload/messages";
import { startMessages } from "../renderer/messages";

startMessages(document, (window as unknown as { multicordMessages: MessagesApi }).multicordMessages);
