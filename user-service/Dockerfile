FROM node:22-alpine

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .

RUN npm run build
EXPOSE 8081
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /usr/src/app
USER app

CMD ["npm", "start"]
