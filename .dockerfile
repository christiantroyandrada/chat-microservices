FROM node:lts-alpine

WORKDIR /usr/src/server

COPY package*.json ./

RUN npm ci --quiet --only=production

COPY . .

ENV PORT=8080

EXPOSE 8080

CMD [ "npm", "start" ]