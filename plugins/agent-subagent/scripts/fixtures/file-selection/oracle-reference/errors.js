export class OracleUserError extends Error {
    category;
    details;
    constructor(category, message, details, cause) {
        super(message);
        this.name = "OracleUserError";
        this.category = category;
        this.details = details;
        if (cause) {
            this.cause = cause;
        }
    }
}
export class FileValidationError extends OracleUserError {
    constructor(message, details, cause) {
        super("file-validation", message, details, cause);
        this.name = "FileValidationError";
    }
}
