import { useEffect, useState } from "react";
import type {
	AppInfo,
	AppSettings as AppPreferences,
	Backend,
	ProviderAuthInfo,
} from "../../../shared/types";
import { api } from "../../rpc";
import { About } from "./app/About";
import { Agents } from "./app/Agents";
import { General } from "./app/General";
import { Mcp } from "./app/Mcp";
import { Storage } from "./app/Storage";
import { ToadAgent } from "./app/ToadAgent";
import type { AppDetailId, AppSectionId } from "./sections";

/**
 * What is true of Toad rather than of any one teammate.
 *
 * The settings, the app's own particulars, and the built-in agent's providers
 * are read once and held here, so that moving between sections — or drilling
 * into the agent pane and back — is navigation rather than another round of
 * the same reads.
 */

type Props = {
	section: AppSectionId;
	detail: AppDetailId | undefined;
	backends: Backend[];
	onRefreshBackends(): Promise<unknown>;
	onOpenDetail(detail: AppDetailId): void;
	onCloseDetail(): void;
};

export function AppPane({
	section,
	detail,
	backends,
	onRefreshBackends,
	onOpenDetail,
	onCloseDetail,
}: Props) {
	const [settings, setSettings] = useState<AppPreferences | null>(null);
	const [info, setInfo] = useState<AppInfo | null>(null);
	const [providers, setProviders] = useState<ProviderAuthInfo[] | null>(null);
	const [providerError, setProviderError] = useState("");
	const [refreshing, setRefreshing] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void Promise.all([api.getAppSettings(), api.getAppInfo()]).then(([next, about]) => {
			if (cancelled) return;
			setSettings(next);
			setInfo(about);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	/* Provider auth is only wanted by the agent surfaces, and asking for it
	 * touches every provider's auth check — so it is read when one of those is
	 * on screen rather than whenever settings open. */
	const loadProviders = async () => {
		setProviderError("");
		try {
			setProviders(await api.listProviderAuth());
		} catch (error) {
			setProviderError(error instanceof Error ? error.message : String(error));
			setProviders([]);
		}
	};

	useEffect(() => {
		if (section !== "backends") return;
		void loadProviders();
	}, [section]);

	const update = (patch: Partial<AppPreferences>) => {
		/* Optimistic, because the write is a local file and the select snapping
		 * back to its old value reads as a broken control. */
		setSettings((current) => (current ? { ...current, ...patch } : current));
		void api.updateAppSettings(patch).then(setSettings);
	};

	const refresh = async () => {
		setRefreshing(true);
		try {
			await onRefreshBackends();
		} finally {
			setRefreshing(false);
		}
	};

	switch (section) {
		case "general":
			return <General backends={backends} settings={settings} onUpdateSettings={update} />;
		case "backends":
			return detail === "toad-agent" ? (
				<ToadAgent
					providers={providers}
					error={providerError}
					onReload={loadProviders}
					onBack={onCloseDetail}
				/>
			) : (
				<Agents
					backends={backends}
					isDefault={settings?.defaultBackendId === "pi"}
					connectedProviders={
						providers === null
							? null
							: providers.filter((provider) => provider.configured).length
					}
					refreshing={refreshing}
					onRefresh={() => void refresh()}
					onConfigureToadAgent={() => onOpenDetail("toad-agent")}
				/>
			);
		case "mcp":
			return <Mcp settings={settings} onUpdateSettings={update} />;
		case "storage":
			return <Storage info={info} />;
		case "about":
			return <About info={info} />;
	}
}
