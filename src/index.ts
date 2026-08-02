export { configure, resolveParameter, getExposure, trackEvent, flush, reset, ready } from './client';
export { VERSION } from './version';

export type { ConfigInput, Config, Logger, ErrorCallback } from './config';
export type { User, UserInput } from './user';
export type { Assignment, AssignmentsPayload, ExposureMetadata } from './assignments-cache';
export type { ExposureRecord } from './client';
export { ApiError } from './api-error';
