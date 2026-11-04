// Node ESM hooks: serve gi:// and resource:// imports from gi-stubs.mjs.
import {pathToFileURL} from 'node:url';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const stubs = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'gi-stubs.mjs')).href;

export async function resolve(specifier, context, next) {
    if (specifier.startsWith('gi://') || specifier.startsWith('resource://'))
        return {url: `stub:${specifier}`, shortCircuit: true};
    return next(specifier, context);
}

export async function load(url, context, next) {
    if (!url.startsWith('stub:'))
        return next(url, context);
    const spec = url.slice(5);
    let source;
    if (spec.endsWith('/main.js')) {
        source = `import {Main as M} from '${stubs}'; export const layoutManager = M.layoutManager, sessionMode = M.sessionMode,
            overview = M.overview, wm = M.wm, pushModal = M.pushModal, popModal = M.popModal, activateWindow = M.activateWindow;`;
    } else if (spec.endsWith('/appFavorites.js')) {
        source = `import {AppFavorites as A} from '${stubs}'; export const getAppFavorites = A.getAppFavorites;`;
    } else {
        const name = spec.replace('gi://', '');
        source = `import * as S from '${stubs}'; import {makeStub} from '${stubs}';
            export default S.gi['${name}'] ?? S.${name} ?? makeStub('${name}');`;
    }
    return {format: 'module', shortCircuit: true, source};
}
