/**
 * Shared low-level helpers for provider adapters: timed fetch, defensive
 * payload coercion, timestamp normalization, and error-body redaction.
 */

import { SECOND_MS } from "./countdown";

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function assertObject(
	value: unknown,
	description: string,
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${description} was not an object.`);
	}
	return value as Record<string, unknown>;
}

export function parseJsonObject(text: string, description: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`${description} was not valid JSON: ${errorMessage(error)}`);
	}
	return assertObject(parsed, description);
}

export async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s while fetching usage.`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

/** Accepts epoch seconds/ms and ISO-8601 strings; returns epoch ms. */
export function asTimestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		if (value <= 0) return undefined;
		return value < 10_000_000_000 ? value * SECOND_MS : value;
	}
	if (typeof value === "string" && value.trim()) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return asTimestampMs(numeric);
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function asResetTime(
	absoluteValues: unknown[],
	relativeSeconds: unknown,
	capturedAt: number,
): number | undefined {
	for (const value of absoluteValues) {
		const timestamp = asTimestampMs(value);
		if (timestamp !== undefined) return timestamp;
	}
	const seconds = asNumber(relativeSeconds);
	if (seconds === undefined || seconds < 0) return undefined;
	return capturedAt + seconds * SECOND_MS;
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

export function truncateEnd(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars - 1)}…`;
}

export function redactErrorBody(body: string, maxChars = 600): string {
	return truncateEnd(
		body
			.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
			.replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
			.trim(),
		maxChars,
	);
}

export function normalizedUsageKey(value: string | undefined): string | undefined {
	const key = value
		?.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return key || undefined;
}
