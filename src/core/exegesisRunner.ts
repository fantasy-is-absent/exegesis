import * as http from 'http';
import { Readable } from 'stream';

import { invokeController } from '../controllers/invoke';
import stringToStream from '../utils/stringToStream';
import { ValidationError } from '../errors';
import { ExegesisRunner, HttpResult, ExegesisContext, ResponseValidationCallback } from '../types';
import { ApiInterface, ResolvedOperation, ExegesisPluginInstance } from '../types/internal';
import ExegesisContextImpl from './ExegesisContextImpl';
import bufferToStream from '../utils/bufferToStream';
import { isReadable } from '../utils/typeUtils';

async function handleSecurity(operation: ResolvedOperation, context: ExegesisContext) {
    const authenticated = await operation.authenticate(context);
    context.security = authenticated;
    if(authenticated) {
        const matchedSchemes = Object.keys(authenticated);
        if(matchedSchemes.length === 1) {
            context.user = authenticated[matchedSchemes[0]].user;
        }
    }
}

function resultToHttpResponse(
    context: ExegesisContext,
    result: any
) : HttpResult {
    let output: Readable | undefined;
    const headers = context.res.headers;

    if(result) {
        if(result instanceof Buffer) {
            output = bufferToStream(result);
        } else if(typeof result === 'string') {
            output = stringToStream(result);
        } else if(isReadable(result)) {
            output = result;
        } else {
            if(!headers['content-type']) {
                headers['content-type'] = 'application/json';
            }
            output = stringToStream(JSON.stringify(result), 'utf-8');
        }
    }

    return {
        status: context.res.statusCode,
        headers,
        body: output
    };
}

function handleError(err: Error) {
    if(err instanceof ValidationError) {
        // TODO: Allow customization of validation error?  Or even
        // just throw the error instead of turning it into a message?
        const jsonError = {
            message: "Validation errors",
            errors: err.errors
        };
        return {
            status: err.status,
            headers: {"content-type": "application/json"},
            body: stringToStream(JSON.stringify(jsonError), 'utf-8')
        };
    } else if(Number.isInteger((err as any).status)) {
        return {
            status: (err as any).status,
            headers: {"content-type": "application/json"},
            body: stringToStream(JSON.stringify({message: err.message}), 'utf-8')
        };
    } else {
        throw err;
    }
}

/**
 * Returns a `(req, res) => Promise<boolean>` function, which handles incoming
 * HTTP requests.  The returned function will return true if the request was
 * handled, and false otherwise.
 *
 * @returns runner function.
 */
export default async function generateExegesisRunner<T>(
    api: ApiInterface<T>,
    options: {
        autoHandleHttpErrors: boolean,
        plugins: ExegesisPluginInstance[],
        onResponseValidationError: ResponseValidationCallback,
        validateDefaultResponses: boolean
    }
) : Promise<ExegesisRunner> {
    const plugins = options.plugins;

    return async function exegesisRunner(
        req: http.IncomingMessage,
        res: http.ServerResponse
    ) : Promise<HttpResult | undefined> {
        const method = req.method || 'get';
        const url = req.url || '/';

        let result: HttpResult | undefined;

        try {

            const resolved = api.resolve(method, url, req.headers);

            if(resolved && resolved.operation) {
                const {operation} = resolved;

                if(!operation.controllerModule || !operation.controller) {
                    throw new Error(`No controller found for ${method} ${url}`);
                }

                const context = new ExegesisContextImpl<T>(req, res, resolved.api, operation);
                await handleSecurity(operation, context);

                for(const plugin of plugins) {
                    if(!context.isResponseFinished() && plugin.preController) {
                        await plugin.preController(context);
                    }
                }

                if(!context.isResponseFinished()) {
                    // Fill in context.params and context.body.
                    await context.getParams();
                    await context.getBody();
                }

                let controllerResult: any;
                if(!context.isResponseFinished()) {
                    controllerResult = await invokeController(
                        operation.controllerModule,
                        operation.controller,
                        context
                    );
                }

                if(!context.isResponseFinished()) {
                    if(options.onResponseValidationError) {
                        const responseValidationResult = resolved.operation.validateResponse(
                            context.res,
                            options.validateDefaultResponses
                        );
                        try {
                            if(responseValidationResult.errors && responseValidationResult.errors.length) {
                                options.onResponseValidationError(responseValidationResult as any);
                            }
                        } catch(err) {
                            err.status = err.status || 500;
                            throw err;
                        }
                    }
                }

                if(!context.origRes.headersSent) {
                    result = resultToHttpResponse(context, context.res.body || controllerResult);
                }
            }

            return result;

        } catch (err) {
            if(options.autoHandleHttpErrors) {
                return handleError(err);
            } else {
                throw err;
            }
        }
    };
}