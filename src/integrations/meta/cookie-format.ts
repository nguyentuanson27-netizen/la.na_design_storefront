/**
 * Shapes of Meta's first-party browser cookies. The server validator and the browser's wait for
 * `_fbp` share them, so the browser never treats as ready a cookie the server would then drop.
 */
export const META_COOKIE_MAX_LENGTH = 512;
export const META_FBP_PATTERN = /^fb\.\d+\.\d{13}\.[0-9]+(?:\.[A-Za-z0-9_-]+)?$/;
export const META_FBC_PATTERN = /^fb\.\d+\.\d{13}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
