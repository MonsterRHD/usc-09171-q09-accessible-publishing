// 领域错误：携带 HTTP 状态码与机器可读错误码，细节（如门禁违规列表）透传给调用方。
export class DomainError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new DomainError(400, "bad-request", message, details);
export const forbidden = (message, details) => new DomainError(403, "forbidden", message, details);
export const notFound = (message, details) => new DomainError(404, "not-found", message, details);
export const conflict = (message, details) => new DomainError(409, "conflict", message, details);
