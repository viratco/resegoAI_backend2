import express, { Request, Response, RequestHandler } from 'express';

const router = express.Router();

interface SignInBody {
  email: string;
  password: string;
}

interface SignUpBody extends SignInBody {
  fullName: string;
}

type SignUpHandler = RequestHandler<{}, any, SignUpBody>;
type SignInHandler = RequestHandler<{}, any, SignInBody>;

const signUpHandler: SignUpHandler = async (req, res) => {
  try {
    // Just return success since auth is handled by Supabase
    res.json({ 
      message: 'Signup successful'
    });
  } catch (error: any) {
    res.status(400).json({ 
      error: error.message 
    });
  }
};

const signInHandler: SignInHandler = async (req, res) => {
  try {
    // Just return success since auth is handled by Supabase
    res.json({ 
      message: 'Signin successful'
    });
  } catch (error: any) {
    res.status(500).json({ 
      error: error.message 
    });
  }
};

router.post('/signup', signUpHandler);
router.post('/signin', signInHandler);

export default router; 