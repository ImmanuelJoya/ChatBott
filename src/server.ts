import cors from 'cors'; 
import dotenv from 'dotenv';
import { eq } from 'drizzle-orm';
import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import { StreamChat } from 'stream-chat';
import { db } from './config/database.js';
import { chats, users } from './db/schema.js';

dotenv.config();

// Validate environment variables
const requiredEnvVars = ['STREAM_API_KEY', 'STREAM_API_SECRET', 'DEEPSEEK_API_KEY'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`Missing required environment variable: ${envVar}`);
        process.exit(1);
    }
}
console.log('Loaded DEEPSEEK_API_KEY:', process.env.DEEPSEEK_API_KEY);

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Initialize Stream Client
const chatClient = StreamChat.getInstance(
    process.env.STREAM_API_KEY!,
    process.env.STREAM_API_SECRET!
);

// Register user with Stream Chat
app.post(
    '/register-user',
    async (req: Request, res: Response): Promise<any> => {
        const { name, email } = req.body;

        if (!name || !email) {
            return res.status(400).json({ error: 'Name and email are required' });
        }

        try {
            const userId = email.replace(/[^a-zA-Z0-9_-]/g, '_');

            // Check if user exists
            const userResponse = await chatClient.queryUsers({ id: { $eq: userId } });

            if (!userResponse.users.length) {
                // Add new user to stream
                await chatClient.upsertUser({
                    id: userId,
                    name: name,
                    email: email,
                    role: 'user',
                });
            }

            const Visiter = () => {
                console.log(`${name} visited on ${new Date()} with following email: ${email}`);
            };

            // Check for existing user in database
            const existingUser = await db
                .select()
                .from(users)
                .where(eq(users.userId, userId));

            if (!existingUser.length) {
                console.log(
                    `User ${userId} does not exist in the database. Adding them...`
                );
                await db.insert(users).values({ userId, name, email });
            }

            res.status(200).json({ userId, name, email });
        } catch (error) {
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
);

// Send message to AI
app.post('/chat', async (req: Request, res: Response): Promise<any> => {
    console.log('Raw body before parsing:', req.body);

    // Extract and trim keys to handle trailing spaces
    const userId = Object.keys(req.body)
        .find(key => key.trim().toLowerCase() === 'userid')?.trim() || '';
    const message = Object.keys(req.body)
        .find(key => key.trim().toLowerCase() === 'message')?.trim() || '';

    // Get the values using the trimmed keys
    const extractedUserId = req.body[userId];
    const extractedMessage = req.body['message '] || req.body['message'] || req.body['Message'] || req.body['MESSAGE'];

    console.log('Extracted userId:', extractedUserId, 'Extracted message:', extractedMessage);

    if (!extractedMessage || !extractedUserId) {
        return res.status(400).json({ error: 'Message and userId are required' });
    }

    try {
        // Verify user exists in StreamChat
        const userResponse = await chatClient.queryUsers({ id: extractedUserId });
        if (!userResponse.users.length) {
            return res.status(404).json({ error: 'User not found. Please register first' });
        }

        // Check user in database
        const existingUser = await db
            .select()
            .from(users)
            .where(eq(users.userId, extractedUserId));
        if (!existingUser.length) {
            return res.status(404).json({ error: 'User not found in database, please register' });
        }

        // Fetch user's past messages for context
        const chatHistory = await db
            .select()
            .from(chats)
            .where(eq(chats.userId, extractedUserId))
            .orderBy(chats.createdAt)
            .limit(10);

        // Format chat history for OpenRouter API
        const messages = chatHistory.flatMap(
            (chat) => {
                const history = [
                    { role: 'user', content: chat.message },
                ];
                if (chat.reply) {
                    history.push({ role: 'assistant', content: chat.reply });
                }
                return history;
            }
        );

        // Add latest user message to the conversation
        messages.push({ role: 'user', content: extractedMessage });

        // Send message to OpenRouter API
        console.log('Using DEEPSEEK_API_KEY for request:', process.env.DEEPSEEK_API_KEY);
        let response;
        try {
            response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                    'HTTP-Referer': 'http://localhost:8000', // Replace with your site URL if deployed
                    'X-Title': 'ChatAI', // Replace with your site name
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'deepseek/deepseek-r1-zero:free',
                    messages: messages,
                }),
            });
        } catch (fetchError) {
            console.error('Fetch error details:', (fetchError as Error).message);
            throw new Error(`Failed to fetch from OpenRouter API: ${(fetchError as Error).message}`);
        }

        if (!response.ok) {
            const errorText = await response.text();
            console.error('OpenRouter API response error:', response.status, errorText);
            throw new Error(`OpenRouter API request failed: ${response.status} ${errorText}`);
        }

        // Parse the JSON response from OpenRouter
        const data = await response.json() as { choices: { message: { content: string } }[] };
        console.log('OpenRouter API response:', data);

        // Extract the assistant's reply
        const aiMessage: string = data.choices[0]?.message?.content || 'No response from AI';

        // Save chat to database
        await db.insert(chats).values({ userId: extractedUserId, message: extractedMessage, reply: aiMessage });

        // Create or get channel
        const channel = chatClient.channel('messaging', `chat-${extractedUserId}`, {
            name: 'AI Chat',
            created_by_id: 'ai_bot',
        });

        await channel.create();
        await channel.sendMessage({ text: aiMessage, user_id: 'ai_bot' });

        res.status(200).json({ reply: aiMessage });
    } catch (error) {
        console.error('Error generating AI response:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get chat history for a user
app.post('/get-messages', async (req: Request, res: Response): Promise<any> => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
    }

    try {
        const chatHistory = await db
            .select()
            .from(chats)
            .where(eq(chats.userId, userId));

        res.status(200).json({ messages: chatHistory });
    } catch (error) {
        console.log('Error fetching chat history', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

const PORT = process.env.PORT || 8000;

app.listen(PORT, () => console.log(`Server running on ${PORT}`));

console.log('Loaded DEEPSEEK_API_KEY:', process.env.DEEPSEEK_API_KEY);
export default app;
