/**
 * Domain errors thrown by modules and guards. Server actions translate
 * these into user-facing form errors; anything else is treated as an
 * unexpected failure, logged and shown as a generic message.
 */
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "You don't have permission to do that.") {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found.") {
    super(message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "This conflicts with the current state.") {
    super(message);
  }
}
