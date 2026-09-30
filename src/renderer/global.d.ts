import type { SuonetarApi, SuonetarShell } from "../shared/api.ts";

declare global {
	interface Window {
		readonly suonetar: SuonetarApi;
		readonly suonetarShell: SuonetarShell;
	}
}
