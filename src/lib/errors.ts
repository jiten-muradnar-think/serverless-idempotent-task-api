export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (code: string, msg: string) => new HttpError(400, code, msg);
export const unauthorized = (msg = 'Missing or invalid credentials') =>
  new HttpError(401, 'unauthorized', msg);
export const conflict = (code: string, msg: string, detail?: Record<string, unknown>) =>
  new HttpError(409, code, msg, detail);
