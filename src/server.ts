import cors from "cors"
import dotenv from "dotenv"
import express, { Request, Response } from "express"
import { StreamChat } from "stream-chat"

dotenv.config()

const app = express()

app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: false }))


//Initilize stream client
const chatClient = StreamChat.getInstance(
    process.env.STREAM_API_KEY!,  //"!" telling ts that we are sure it has a value, that its not gonna be null or undefined
    process.env.STREAM_API_SECRET!
)

// Register user with Stream Chat
app.post(
    '/register-user',
    async (req: Request, res: Response): Promise<any> => {
        const { name, email } = req.body;

        if (!name || !email) {
            return res.status(400).json({ error: 'Missing name or email' })
        }

        try {

            const userId = email.replace(/[^a-zA-Z0-9]/g, '_') //replace special characters with underscore
            console.log(userId);

            res.status(200).json({ message: 'User registered successfully' })
        }
        catch (error) {
            res.status(500).json({ error: 'Internal server error' })
        }



    })

const PORT = process.env.PORT || 5000

app.listen(PORT, () => {
    console.log(`Server currently running on port ${PORT}`)
    console.log(`http://localhost:${PORT}`);
})
