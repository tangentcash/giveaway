FROM node:22-alpine AS build
WORKDIR /home/make
RUN apk add git
COPY ./ /home/make
RUN yarn && yarn build:client

FROM node:22-alpine AS deploy
WORKDIR /home/make
COPY --from=build /home/make /home/make
EXPOSE 20420
ENTRYPOINT ["yarn", "dev:server"]