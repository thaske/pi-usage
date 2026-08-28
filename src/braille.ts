/**
 * Braille subpixel bars, ported from the Codex usage convention:
 * 10 terminal cells, each an 2x4 braille dot grid used as two vertical
 * halves (left = primary window, right = secondary window) with 2 fill
 * steps per half. A dual bar therefore has 20 parts per window.
 *
 * Bars always render the REMAINING share of the quota.
 */

export const DUAL_BAR_WIDTH = 10;
export const DUAL_BAR_PARTS = DUAL_BAR_WIDTH * 2;
export const SINGLE_BAR_PARTS = DUAL_BAR_WIDTH * 4;

export const DUAL_BAR_CHARS = [
	"⠀",
	"▘",
	"▝",
	"▀",
	"▖",
	"▌",
	"▞",
	"▛",
	"▗",
	"▚",
	"▐",
	"▜",
	"▄",
	"▙",
	"▟",
	"█",
];

export function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

export function remainingPercent(usedPercent: number): number {
	return 100 - clampPercent(usedPercent);
}

function filledParts(usedPercent: number | undefined, totalParts: number): number {
	if (usedPercent === undefined) return 0;
	const remaining = remainingPercent(usedPercent);
	if (remaining <= 0) return 0;
	return Math.max(1, Math.round(remaining / (100 / totalParts)));
}

/** 10-cell single-window bar (4 braille steps per cell, 40 parts total). */
export function formatSingleBar(usedPercent: number | undefined): string {
	const filled = filledParts(usedPercent, SINGLE_BAR_PARTS);
	const partMasks = [1, 4, 2, 8];
	let value = "";
	for (let index = 0; index < DUAL_BAR_WIDTH; index++) {
		const cellParts = Math.min(4, Math.max(0, filled - index * 4));
		let mask = 0;
		for (let part = 0; part < cellParts; part++) mask |= partMasks[part] ?? 0;
		value += DUAL_BAR_CHARS[mask];
	}
	return value;
}

/** 10-cell dual-window bar: left halves = primary, right halves = secondary. */
export function formatDualBar(
	primaryUsedPercent: number | undefined,
	secondaryUsedPercent: number | undefined,
): string {
	const primaryParts = filledParts(primaryUsedPercent, DUAL_BAR_PARTS);
	const secondaryParts = filledParts(secondaryUsedPercent, DUAL_BAR_PARTS);
	let value = "";
	for (let index = 0; index < DUAL_BAR_WIDTH; index++) {
		const leftPart = index * 2 + 1;
		const rightPart = leftPart + 1;
		let mask = 0;
		if (primaryParts >= leftPart) mask |= 1;
		if (primaryParts >= rightPart) mask |= 2;
		if (secondaryParts >= leftPart) mask |= 4;
		if (secondaryParts >= rightPart) mask |= 8;
		value += DUAL_BAR_CHARS[mask];
	}
	return value;
}

/** Dual bar when both windows exist, single bar otherwise. */
export function formatAdaptiveBar(
	primaryUsedPercent: number | undefined,
	secondaryUsedPercent: number | undefined,
): string {
	if (primaryUsedPercent === undefined || secondaryUsedPercent === undefined) {
		return formatSingleBar(primaryUsedPercent ?? secondaryUsedPercent);
	}
	return formatDualBar(primaryUsedPercent, secondaryUsedPercent);
}

/** Ping-pong loading animation over the dual-bar cell halves. */
export function formatLoadingBar(frame: number): string {
	const totalParts = DUAL_BAR_PARTS;
	const cycleFrames = (totalParts - 1) * 2;
	const finiteFrame = Number.isFinite(frame) ? frame : 0;
	const cycleFrame = Math.abs(Math.trunc(finiteFrame)) % cycleFrames;
	const primaryPart = cycleFrame < totalParts ? cycleFrame : cycleFrames - cycleFrame;
	const secondaryPart = totalParts - primaryPart - 1;
	const masks = Array<number>(DUAL_BAR_WIDTH).fill(0);
	const primaryCell = Math.floor(primaryPart / 2);
	const secondaryCell = Math.floor(secondaryPart / 2);
	masks[primaryCell] = (masks[primaryCell] ?? 0) | (primaryPart % 2 === 0 ? 1 : 2);
	masks[secondaryCell] = (masks[secondaryCell] ?? 0) | (secondaryPart % 2 === 0 ? 4 : 8);
	return masks.map((mask) => DUAL_BAR_CHARS[mask]).join("");
}
