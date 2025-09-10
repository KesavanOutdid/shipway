# Use Node.js Alpine as base
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the app
COPY . .

# Expose port
EXPOSE 8013

# Start app in development mode (or change to `npm run build && npm start` for production)
CMD ["npm", "run", "dev"]
