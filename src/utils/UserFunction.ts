/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * This module defines the functions for loading the user's code as specified
 * in a handler string.
 */

"use strict";

import path from "path";
import fs from "fs";
import { createRequire } from "module";
import { HandlerFunction } from "../Common/index.js";
import {
  HandlerNotFound,
  MalformedHandlerName,
  ImportModuleError,
  UserCodeSyntaxError,
} from "../Errors/index.js";

const FUNCTION_EXPR = /^([^.]*)\.(.*)$/;
const RELATIVE_PATH_SUBSTRING = "..";

/**
 * Break the full handler string into two pieces, the module root and the actual
 * handler string.
 * Given './somepath/something/module.nestedobj.handler' this returns
 * ['./somepath/something', 'module.nestedobj.handler']
 */
function _moduleRootAndHandler(fullHandlerString: string): [string, string] {
  const handlerString = path.basename(fullHandlerString);
  const moduleRoot = fullHandlerString.substring(
    0,
    fullHandlerString.indexOf(handlerString)
  );
  return [moduleRoot, handlerString];
}

/**
 * Split the handler string into two pieces: the module name and the path to
 * the handler function.
 */
function _splitHandlerString(handler: string): [string, string] {
  const match = handler.match(FUNCTION_EXPR);
  if (!match || match.length != 3) {
    throw new MalformedHandlerName("Bad handler");
  }
  return [match[1], match[2]]; // [module, function-path]
}

/**
 * Resolve the user's handler function from the module.
 */
function _resolveHandler(object: any, nestedProperty: string): any {
  return nestedProperty.split(".").reduce((nested, key) => {
    return nested && nested[key];
  }, object);
}

/**
 * Verify that the provided path can be loaded as a file per:
 * https://nodejs.org/dist/latest-v10.x/docs/api/modules.html#modules_all_together
 * @param modulePath {string} - the fully resolved file path to the module
 * @return bool
 */
function _canLoadAsFile(modulePath: string): boolean {
  return fs.existsSync(modulePath);
}

/**
 * Attempts to directly resolve the module relative to the application root,
 * then falls back to the more general require().
 */
function _tryImport(
  appRoot: string,
  moduleRoot: string,
  module: string
): string {
  const lambdaStylePath = path.resolve(appRoot, moduleRoot, module) + ".js";
  if (_canLoadAsFile(lambdaStylePath)) {
    return lambdaStylePath;
  } else {
    // Why not just require.resolve(module)?
    // Because require() is relative to __dirname, not process.cwd()
    const require = createRequire(import.meta.url);
    return require.resolve(module, {
      paths: [appRoot, moduleRoot],
    });
  }
}

function _throwIfInvalidHandler(fullHandlerString: string): void {
  if (fullHandlerString.includes(RELATIVE_PATH_SUBSTRING)) {
    throw new MalformedHandlerName(
      `'${fullHandlerString}' is not a valid handler name. Use absolute paths when specifying root directories in handler names.`
    );
  }
}

/**
 * Load the user's function with the approot and the handler string.
 * @param appRoot {string}
 *   The path to the application root.
 * @param fullHandlerString {string}
 *   The user-provided handler function in the form 'module.function'.
 * @return userFunction {function}
 *   The user's handler function. This function will be passed the event body,
 *   the context object, and the callback function.
 * @throws In five cases:-
 *   1 - if the handler string is incorrectly formatted an error is thrown
 *   2 - if the module referenced by the handler cannot be loaded
 *   3 - if the function in the handler does not exist in the module
 *   4 - if a property with the same name, but isn't a function, exists on the
 *       module
 *   5 - the handler includes illegal character sequences (like relative paths
 *       for traversing up the filesystem '..')
 *   Errors for scenarios known by the runtime, will be wrapped by Runtime.* errors.
 */
export const load = function (
  appRoot: string,
  fullHandlerString: string
): HandlerFunction {
  _throwIfInvalidHandler(fullHandlerString);

  const [moduleRoot, moduleAndHandler] = _moduleRootAndHandler(
    fullHandlerString
  );
  const [module, handlerPath] = _splitHandlerString(moduleAndHandler);

  const modulePath = _tryImport(appRoot, moduleRoot, module);

  return async (...args: unknown[]) => {
    const moduleExports = await import(modulePath).catch((e) => {
      if (e instanceof SyntaxError) {
        throw new UserCodeSyntaxError(<any>e);
      } else if (e.code !== undefined && e.code === "MODULE_NOT_FOUND") {
        throw new ImportModuleError(e);
      } else {
        throw e;
      }
    });

    const handlerFunc = _resolveHandler(moduleExports, handlerPath);

    if (!handlerFunc) {
      throw new HandlerNotFound(
        `${fullHandlerString} is undefined or not exported`
      );
    }

    if (typeof handlerFunc !== "function") {
      throw new HandlerNotFound(`${fullHandlerString} is not a function`);
    }

    return handlerFunc(...args);
  };
};
