FROM node:22-alpine

WORKDIR /app

# Dev dependencies stay: TypeScript builds the app, and tsx runs
# `npm run db:migrate` / `npm run seed:superadmin` inside the container.
COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

# Starting the server brings the tables up to date (everything that adds);
# deletions only ever happen through `npm run db:migrate -- --force`.
CMD ["node", "dist/server.js"]
