import type { ConfigChoice } from "../../shared/types";

/**
 * What `session/new` (and later `session/set_config_option`) actually carries
 * for the two pickers Toad already has, plus any leftover select options.
 *
 * Cursor still ships the older `models` / `modes` fields. Claude Code's ACP
 * adapter prefers `configOptions` — same data, plus effort, keyed by `configId`
 * rather than a dedicated RPC. One function reads either shape so the header
 * does not have to know which agent it is talking to.
 */

export type SessionConfigOption = {
	id: string;
	name: string;
	description?: string | null;
	category?: string | null;
	type?: string;
	currentValue?: string | boolean | null;
	options?: Array<{ value: string; name: string; description?: string | null }>;
};

export type SessionConfigPicker = {
	id: string;
	name: string;
	currentId?: string;
	options: ConfigChoice[];
};

export type SessionDisposition = {
	models: ConfigChoice[];
	currentModelId?: string;
	modelConfigId?: string;
	modelLabel?: string;
	modes: ConfigChoice[];
	currentModeId?: string;
	modeConfigId?: string;
	modeLabel?: string;
	configs: SessionConfigPicker[];
};

export type SessionSetup = {
	models?: {
		currentModelId?: string;
		availableModels?: Array<{ modelId: string; name: string; description?: string }>;
	};
	modes?: {
		currentModeId?: string;
		availableModes?: Array<{ id: string; name: string; description?: string }>;
	};
	configOptions?: SessionConfigOption[] | null;
};

export function dispositionOf(res?: SessionSetup | null): SessionDisposition {
	const selects = (res?.configOptions ?? []).filter(isSelect);
	if (selects.length > 0) return fromConfigOptions(selects);

	const models = (res?.models?.availableModels ?? []).map((model) => ({
		id: model.modelId,
		name: model.name,
		description: model.description,
	}));
	const modes = (res?.modes?.availableModes ?? []).map((mode) => ({
		id: mode.id,
		name: mode.name,
		description: mode.description,
	}));
	return {
		models,
		currentModelId: res?.models?.currentModelId,
		modes,
		currentModeId: res?.modes?.currentModeId,
		configs: [],
	};
}

function fromConfigOptions(selects: SessionConfigOption[]): SessionDisposition {
	const taken = new Set<string>();
	const take = (match: (option: SessionConfigOption) => boolean): SessionConfigOption | undefined => {
		const option = selects.find((candidate) => !taken.has(candidate.id) && match(candidate));
		if (option) taken.add(option.id);
		return option;
	};

	const model =
		take((option) => option.category === "model") ??
		take((option) => option.id === "model");
	const mode =
		take((option) => option.category === "mode") ??
		take((option) => option.id === "mode") ??
		take((option) => option.category === "thought_level") ??
		take((option) => option.id === "effort" || option.category === "effort") ??
		take((option) => option.category === "model_config");

	const modelPicker = model ? toPicker(model) : undefined;
	const modePicker = mode ? toPicker(mode) : undefined;
	return {
		models: modelPicker?.options ?? [],
		currentModelId: modelPicker?.currentId,
		modelConfigId: model?.id,
		modelLabel: model?.name,
		modes: modePicker?.options ?? [],
		currentModeId: modePicker?.currentId,
		modeConfigId: mode?.id,
		modeLabel: mode?.name,
		configs: selects
			.filter((option) => !taken.has(option.id))
			.filter(isHeaderConfig)
			.map(toPicker),
	};
}

function isHeaderConfig(option: SessionConfigOption): boolean {
	return (
		option.category === "thought_level" ||
		option.category === "model_config" ||
		option.category === "effort" ||
		option.id === "effort"
	);
}

function toPicker(option: SessionConfigOption): SessionConfigPicker {
	return {
		id: option.id,
		name: option.name,
		currentId: currentId(option),
		options: choicesOf(option),
	};
}

function isSelect(option: SessionConfigOption): boolean {
	return option.type === "select" && Array.isArray(option.options);
}

function currentId(option: SessionConfigOption | undefined): string | undefined {
	return typeof option?.currentValue === "string" ? option.currentValue : undefined;
}

function choicesOf(option: SessionConfigOption): ConfigChoice[] {
	const choices = (option.options ?? []).map((entry) => ({
		id: entry.value,
		name: entry.name,
		description: entry.description ?? undefined,
	}));
	const current = currentId(option);
	if (current && !choices.some((choice) => choice.id === current)) {
		choices.unshift({ id: current, name: current });
	}
	return choices;
}
