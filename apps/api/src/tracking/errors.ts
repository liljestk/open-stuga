import { HttpError } from "../http-error.js";
export class TrackingError extends HttpError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "TrackingError";
  }
}
