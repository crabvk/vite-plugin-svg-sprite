tsc:
    pnpm exec tsc -b

lint:
    pnpm exec biome lint

build:
    rm -rf ./dist
    pnpm exec tsc --build --noEmit false

publish: build
    pnpm publish --access public
