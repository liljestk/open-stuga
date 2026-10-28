import { HttpError } from "../../http-error.js";

export class ClimateDataValidationError extends HttpError {
  declare readonly status: 400 | 404 | 409 | 422;

  constructor(status: 400 | 404 | 409 | 422, code: string, message: string) {
    super(status, code, message);
    this.name = "ClimateDataValidationError";
  }
}
