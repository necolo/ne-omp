# ne-omp

Personal extensions for [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi).

## Extensions

| File | Purpose |
| --- | --- |
| `extensions/chat/index.ts` | `/chat`: temporarily switch to concise discussion mode |
| `extensions/find-model.ts` | `/find-model`: recommend available models and send the original prompt after selection |
| `extensions/tree-delete/index.ts` | `/treed`: delete selected session tree nodes and their descendants |
| `extensions/project/index.ts` | `/project`: manage projects and switch to a new session |
| `extensions/theme/index.ts` | `/theme`: preview, select, hide, and restore themes |
| `extensions/codex-remaining.ts` | Display the remaining 5-hour / 7-day quota for a single Codex account in the status bar |

## Usage

Install omp first. Run the following command from the repository root to start omp with one explicitly loaded extension:

```sh
omp -e ./extensions/chat/index.ts
```

Repeat `-e` to load multiple extensions:

```sh
omp -e ./extensions/project/index.ts -e ./extensions/theme/index.ts
```

`/treed` permanently deletes session nodes. Check the selected nodes and their descendants before using it.

## Development

The omp packages in the development dependencies are pinned to `18.10.0`, matching the local omp version at initialization. When upgrading omp, update these packages and rerun the type check.

```sh
npm install
npm run typecheck
```

The TypeScript configuration enables strict checking for `extensions/**/*.ts` without emitting compiled output; omp loads the extensions directly.

At initialization, `npm run typecheck` reported 14 type errors across 4 existing extension files. Strict checking remains enabled rather than being relaxed to hide errors; extension logic was not modified during initialization.

Some extension directories include a `check.py` script for runtime checks. These scripts are not included in `typecheck`. Review their runtime requirements before running them.
