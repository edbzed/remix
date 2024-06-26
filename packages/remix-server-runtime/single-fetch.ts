import type {
  ActionFunctionArgs as RRActionArgs,
  LoaderFunctionArgs as RRLoaderArgs,
  StaticHandler,
  unstable_DataStrategyFunctionArgs as DataStrategyFunctionArgs,
  unstable_DataStrategyFunction as DataStrategyFunction,
  StaticHandlerContext,
} from "@remix-run/router";
import {
  isRouteErrorResponse,
  UNSAFE_ErrorResponseImpl as ErrorResponseImpl,
} from "@remix-run/router";
import { encode } from "turbo-stream";

import type { AppLoadContext } from "./data";
import { sanitizeError, sanitizeErrors } from "./errors";
import { ServerMode } from "./mode";
import type { TypedDeferredData, TypedResponse } from "./responses";
import { isDeferredData, isRedirectStatusCode, isResponse } from "./responses";
import type { SerializeFrom } from "./serialize";

export const SingleFetchRedirectSymbol = Symbol("SingleFetchRedirect");
const ResponseStubActionSymbol = Symbol("ResponseStubAction");

type SingleFetchRedirectResult = {
  redirect: string;
  status: number;
  revalidate: boolean;
  reload: boolean;
};
export type SingleFetchResult =
  | { data: unknown }
  | { error: unknown }
  | SingleFetchRedirectResult;

export type SingleFetchResults = {
  [key: string]: SingleFetchResult;
  [SingleFetchRedirectSymbol]?: SingleFetchRedirectResult;
};

export type DataStrategyCtx = {
  response: ResponseStub;
};

// We can't use a 3xx status or else the `fetch()` would follow the redirect.
// We need to communicate the redirect back as data so we can act on it in the
// client side router.  We use a 202 to avoid any automatic caching we might
// get from a 200 since a "temporary" redirect should not be cached.  This lets
// the user control cache behavior via Cache-Control
export const SINGLE_FETCH_REDIRECT_STATUS = 202;

export function getSingleFetchDataStrategy(
  responseStubs: ReturnType<typeof getResponseStubs>,
  {
    isActionDataRequest,
    loadRouteIds,
  }: { isActionDataRequest?: boolean; loadRouteIds?: string[] } = {}
): DataStrategyFunction {
  return async ({ request, matches }: DataStrategyFunctionArgs) => {
    // Don't call loaders on action data requests
    if (isActionDataRequest && request.method === "GET") {
      return await Promise.all(
        matches.map((m) =>
          m.resolve(async () => ({ type: "data", result: null }))
        )
      );
    }

    let results = await Promise.all(
      matches.map(async (match) => {
        let responseStub: ResponseStubImpl | undefined;
        if (request.method !== "GET") {
          responseStub = responseStubs[ResponseStubActionSymbol];
        } else {
          responseStub = responseStubs[match.route.id];
        }

        let result = await match.resolve(async (handler) => {
          // Cast `ResponseStubImpl -> ResponseStub` to hide the symbol in userland
          let ctx: DataStrategyCtx = { response: responseStub as ResponseStub };
          // Only run opt-in loaders when fine-grained revalidation is enabled
          let data =
            loadRouteIds && !loadRouteIds.includes(match.route.id)
              ? null
              : await handler(ctx);
          return { type: "data", result: data };
        });

        // Transfer raw Response status/headers to responseStubs
        if (isResponse(result.result)) {
          proxyResponseToResponseStub(
            result.result.status,
            result.result.headers,
            responseStub
          );
        } else if (isDeferredData(result.result) && result.result.init) {
          proxyResponseToResponseStub(
            result.result.init.status,
            new Headers(result.result.init.headers),
            responseStub
          );
        }

        return result;
      })
    );
    return results;
  };
}

export function getSingleFetchResourceRouteDataStrategy({
  responseStubs,
}: {
  responseStubs: ReturnType<typeof getResponseStubs>;
}): DataStrategyFunction {
  return async ({ matches }: DataStrategyFunctionArgs) => {
    let results = await Promise.all(
      matches.map(async (match) => {
        let responseStub = match.shouldLoad
          ? responseStubs[match.route.id]
          : null;
        let result = await match.resolve(async (handler) => {
          // Cast `ResponseStubImpl -> ResponseStub` to hide the symbol in userland
          let ctx: DataStrategyCtx = {
            response: responseStub as ResponseStub,
          };
          let data = await handler(ctx);
          return { type: "data", result: data };
        });
        return result;
      })
    );
    return results;
  };
}

export async function singleFetchAction(
  serverMode: ServerMode,
  staticHandler: StaticHandler,
  request: Request,
  handlerUrl: URL,
  loadContext: AppLoadContext,
  handleError: (err: unknown) => void
): Promise<{ result: SingleFetchResult; headers: Headers; status: number }> {
  try {
    let handlerRequest = new Request(handlerUrl, {
      method: request.method,
      body: request.body,
      headers: request.headers,
      signal: request.signal,
      ...(request.body ? { duplex: "half" } : undefined),
    });

    let responseStubs = getResponseStubs();
    let result = await staticHandler.query(handlerRequest, {
      requestContext: loadContext,
      skipLoaderErrorBubbling: true,
      unstable_dataStrategy: getSingleFetchDataStrategy(responseStubs, {
        isActionDataRequest: true,
      }),
    });

    // Unlike `handleDataRequest`, when singleFetch is enabled, query does
    // let non-Response return values through
    if (isResponse(result)) {
      return {
        result: getSingleFetchRedirect(result.status, result.headers),
        headers: result.headers,
        status: SINGLE_FETCH_REDIRECT_STATUS,
      };
    }

    let context = result;

    let singleFetchResult: SingleFetchResult;
    let { statusCode, headers } = mergeResponseStubs(context, responseStubs, {
      isActionDataRequest: true,
    });

    if (isRedirectStatusCode(statusCode) && headers.has("Location")) {
      return {
        result: getSingleFetchRedirect(statusCode, headers),
        headers,
        status: SINGLE_FETCH_REDIRECT_STATUS,
      };
    }

    // Sanitize errors outside of development environments
    if (context.errors) {
      Object.values(context.errors).forEach((err) => {
        // @ts-expect-error This is "private" from users but intended for internal use
        if ((!isRouteErrorResponse(err) || err.error) && !isResponseStub(err)) {
          handleError(err);
        }
      });
      context.errors = sanitizeErrors(context.errors, serverMode);
    }

    if (context.errors) {
      let error = Object.values(context.errors)[0];
      singleFetchResult = {
        error: isResponseStub(error)
          ? convertResponseStubToErrorResponse(error)
          : error,
      };
    } else {
      singleFetchResult = { data: Object.values(context.actionData || {})[0] };
    }

    return {
      result: singleFetchResult,
      headers,
      status: statusCode,
    };
  } catch (error) {
    handleError(error);
    // These should only be internal remix errors, no need to deal with responseStubs
    return {
      result: { error },
      headers: new Headers(),
      status: 500,
    };
  }
}

export async function singleFetchLoaders(
  serverMode: ServerMode,
  staticHandler: StaticHandler,
  request: Request,
  handlerUrl: URL,
  loadContext: AppLoadContext,
  handleError: (err: unknown) => void
): Promise<{ result: SingleFetchResults; headers: Headers; status: number }> {
  try {
    let handlerRequest = new Request(handlerUrl, {
      headers: request.headers,
      signal: request.signal,
    });
    let loadRouteIds =
      new URL(request.url).searchParams.get("_routes")?.split(",") || undefined;

    let responseStubs = getResponseStubs();
    let result = await staticHandler.query(handlerRequest, {
      requestContext: loadContext,
      skipLoaderErrorBubbling: true,
      unstable_dataStrategy: getSingleFetchDataStrategy(responseStubs, {
        loadRouteIds,
      }),
    });

    if (isResponse(result)) {
      return {
        result: {
          [SingleFetchRedirectSymbol]: getSingleFetchRedirect(
            result.status,
            result.headers
          ),
        },
        headers: result.headers,
        status: SINGLE_FETCH_REDIRECT_STATUS,
      };
    }

    let context = result;

    let { statusCode, headers } = mergeResponseStubs(context, responseStubs);

    if (isRedirectStatusCode(statusCode) && headers.has("Location")) {
      return {
        result: {
          [SingleFetchRedirectSymbol]: getSingleFetchRedirect(
            statusCode,
            headers
          ),
        },
        headers,
        status: SINGLE_FETCH_REDIRECT_STATUS,
      };
    }

    // Sanitize errors outside of development environments
    if (context.errors) {
      Object.values(context.errors).forEach((err) => {
        // @ts-expect-error This is "private" from users but intended for internal use
        if ((!isRouteErrorResponse(err) || err.error) && !isResponseStub(err)) {
          handleError(err);
        }
      });
      context.errors = sanitizeErrors(context.errors, serverMode);
    }

    // Aggregate results based on the matches we intended to load since we get
    // `null` values back in `context.loaderData` for routes we didn't load
    let results: SingleFetchResults = {};
    let loadedMatches = loadRouteIds
      ? context.matches.filter(
          (m) => m.route.loader && loadRouteIds!.includes(m.route.id)
        )
      : context.matches;

    loadedMatches.forEach((m) => {
      let data = context.loaderData?.[m.route.id];
      let error = context.errors?.[m.route.id];
      if (error !== undefined) {
        if (isResponseStub(error)) {
          results[m.route.id] = {
            error: convertResponseStubToErrorResponse(error),
          };
        } else {
          results[m.route.id] = { error };
        }
      } else if (data !== undefined) {
        results[m.route.id] = { data };
      }
    });

    return {
      result: results,
      headers,
      status: statusCode,
    };
  } catch (error: unknown) {
    handleError(error);
    // These should only be internal remix errors, no need to deal with responseStubs
    return {
      result: { root: { error } },
      headers: new Headers(),
      status: 500,
    };
  }
}

export function isResponseStub(value: any): value is ResponseStubImpl {
  return (
    value && typeof value === "object" && ResponseStubOperationsSymbol in value
  );
}

function getResponseStub(status?: number) {
  let headers = new Headers();
  let operations: ResponseStubOperation[] = [];
  let headersProxy = new Proxy(headers, {
    get(target, prop, receiver) {
      if (prop === "set" || prop === "append" || prop === "delete") {
        return (name: string, value: string) => {
          operations.push([prop, name, value]);
          Reflect.apply(target[prop], target, [name, value]);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    status,
    headers: headersProxy,
    [ResponseStubOperationsSymbol]: operations,
  };
}

export function getResponseStubs() {
  return new Proxy({} as Record<string | symbol, ResponseStubImpl>, {
    get(responseStubCache, prop) {
      let cached = responseStubCache[prop];
      if (!cached) {
        responseStubCache[prop] = cached = getResponseStub();
      }
      return cached;
    },
  });
}

function proxyResponseToResponseStub(
  status: number | undefined,
  headers: Headers,
  responseStub: ResponseStubImpl
) {
  if (status != null && responseStub.status == null) {
    responseStub.status = status;
  }
  for (let [k, v] of headers) {
    if (k.toLowerCase() !== "set-cookie") {
      responseStub.headers.set(k, v);
    }
  }

  // Unsure why this is complaining?  It's fine in VSCode but fails with tsc...
  // @ts-ignore - ignoring instead of expecting because otherwise build fails locally
  for (let v of headers.getSetCookie()) {
    responseStub.headers.append("Set-Cookie", v);
  }
}

export function convertResponseStubToErrorResponse(stub: ResponseStub) {
  return new ErrorResponseImpl(stub.status || 500, "", null);
}

export function mergeResponseStubs(
  context: StaticHandlerContext,
  responseStubs: ReturnType<typeof getResponseStubs>,
  { isActionDataRequest }: { isActionDataRequest?: boolean } = {}
) {
  let statusCode: number | undefined = undefined;
  let headers = new Headers();

  // Action followed by top-down loaders
  let actionStub = responseStubs[ResponseStubActionSymbol];
  let stubs = [actionStub];

  // Nothing to merge at the route level on action data requests
  if (!isActionDataRequest) {
    stubs.push(...context.matches.map((m) => responseStubs[m.route.id]));
  }

  for (let stub of stubs) {
    // Take the highest error/redirect, or the lowest success value - preferring
    // action 200's over loader 200s
    if (
      // first status found on the way down
      (statusCode === undefined && stub.status) ||
      // deeper 2xx status found while not overriding the action status
      (statusCode !== undefined &&
        statusCode < 300 &&
        stub.status &&
        statusCode !== actionStub?.status)
    ) {
      statusCode = stub.status;
    }

    // Replay headers operations in order
    let ops = stub[ResponseStubOperationsSymbol];
    for (let [op, ...args] of ops) {
      // @ts-expect-error
      headers[op](...args);
    }
  }

  // If no response stubs set it, use whatever we got back from the router
  // context which handles internal ErrorResponse cases like 404/405's where
  // we may never run a loader/action
  if (statusCode === undefined) {
    statusCode = context.statusCode;
  }
  if (statusCode === undefined) {
    statusCode = 200;
  }

  return { statusCode, headers };
}

export function getSingleFetchRedirect(
  status: number,
  headers: Headers
): SingleFetchRedirectResult {
  return {
    redirect: headers.get("Location")!,
    status,
    revalidate:
      // Technically X-Remix-Revalidate isn't needed here - that was an implementation
      // detail of ?_data requests as our way to tell the front end to revalidate when
      // we didn't have a response body to include that information in.
      // With single fetch, we tell the front end via this revalidate boolean field.
      // However, we're respecting it for now because it may be something folks have
      // used in their own responses
      // TODO(v3): Consider removing or making this official public API
      headers.has("X-Remix-Revalidate") || headers.has("Set-Cookie"),
    reload: headers.has("X-Remix-Reload-Document"),
  };
}

// Note: If you change this function please change the corresponding
// decodeViaTurboStream function in server-runtime
export function encodeViaTurboStream(
  data: any,
  requestSignal: AbortSignal,
  streamTimeout: number | undefined,
  serverMode: ServerMode
) {
  let controller = new AbortController();
  // How long are we willing to wait for all of the promises in `data` to resolve
  // before timing out?  We default this to 50ms shorter than the default value for
  // `ABORT_DELAY` in our built-in `entry.server.tsx` so that once we reject we
  // have time to flush the rejections down through React's rendering stream before `
  // we call abort() on that.  If the user provides their own it's up to them to
  // decouple the aborting of the stream from the aborting of React's renderToPipeableStream
  let timeoutId = setTimeout(
    () => controller.abort(new Error("Server Timeout")),
    typeof streamTimeout === "number" ? streamTimeout : 4950
  );
  requestSignal.addEventListener("abort", () => clearTimeout(timeoutId));

  return encode(data, {
    signal: controller.signal,
    plugins: [
      (value) => {
        // Even though we sanitized errors on context.errors prior to responding,
        // we still need to handle this for any deferred data that rejects with an
        // Error - as those will not be sanitized yet
        if (value instanceof Error) {
          let { name, message, stack } =
            serverMode === ServerMode.Production
              ? sanitizeError(value, serverMode)
              : value;
          return ["SanitizedError", name, message, stack];
        }

        if (value instanceof ErrorResponseImpl) {
          let { data, status, statusText } = value;
          return ["ErrorResponse", data, status, statusText];
        }

        if (
          value &&
          typeof value === "object" &&
          SingleFetchRedirectSymbol in value
        ) {
          return ["SingleFetchRedirect", value[SingleFetchRedirectSymbol]];
        }
      },
    ],
  });
}

type MaybePromise<T> = T | Promise<T>;

type Serializable =
  | undefined
  | null
  | boolean
  | string
  | symbol
  | number
  | Array<Serializable>
  | { [key: PropertyKey]: Serializable }
  | bigint
  | Date
  | URL
  | RegExp
  | Error
  | Map<Serializable, Serializable>
  | Set<Serializable>
  | Promise<Serializable>;

type DataFunctionReturnValue =
  | Serializable
  | TypedDeferredData<Record<string, unknown>>
  | TypedResponse<Record<string, unknown>>;

// Backwards-compatible type for Remix v2 where json/defer still use the old types,
// and only non-json/defer returns use the new types.  This allows for incremental
// migration of loaders to return naked objects.  In the next major version,
// json/defer will be removed so everything will use the new simplified typings.
// prettier-ignore
export type Serialize<T extends Loader | Action> =
  Awaited<ReturnType<T>> extends TypedDeferredData<infer D> ? D :
  Awaited<ReturnType<T>> extends TypedResponse<Record<string, unknown>> ? SerializeFrom<T> :
  Awaited<ReturnType<T>>;

export const ResponseStubOperationsSymbol = Symbol("ResponseStubOperations");
export type ResponseStubOperation = [
  "set" | "append" | "delete",
  string,
  string?
];

/**
 * A stubbed response to let you set the status/headers of your response from
 * loader/action functions
 */
export type ResponseStub = {
  status: number | undefined;
  headers: Headers;
};

export type ResponseStubImpl = ResponseStub & {
  [ResponseStubOperationsSymbol]: ResponseStubOperation[];
};

// loader
type LoaderArgs = RRLoaderArgs<AppLoadContext> & {
  // Context is always provided in Remix, and typed for module augmentation support.
  context: AppLoadContext;
  response: ResponseStub;
};
export type Loader = (
  args: LoaderArgs
) => MaybePromise<DataFunctionReturnValue>;
export let defineLoader = <T extends Loader>(loader: T): T => loader;

// action
type ActionArgs = RRActionArgs<AppLoadContext> & {
  // Context is always provided in Remix, and typed for module augmentation support.
  context: AppLoadContext;
  response: ResponseStub;
};
export type Action = (
  args: ActionArgs
) => MaybePromise<DataFunctionReturnValue>;
export let defineAction = <T extends Action>(action: T): T => action;
