# 1. Use an official Node.js runtime as a parent image
# "bullseye" is a version of Linux (Debian) that works great with FFmpeg
FROM node:18-bullseye

# 2. Install FFmpeg globally in the Linux container
# This is more stable than the npm package for heavy processing
RUN apt-get update && apt-get install -y ffmpeg

# 3. Set the working directory inside the container
WORKDIR /app

# 4. Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# 5. Copy the rest of your app's source code
COPY . .

# 6. Create a temporary folder for uploads (Linux permission safety)
RUN mkdir -p /tmp/uploads && chmod 777 /tmp/uploads

# 7. Hugging Face Spaces expects apps to run on port 7860
ENV PORT=7860
EXPOSE 7860

# 8. Define the command to run your app
CMD ["node", "index.js"]