import sys
import os

# Add parent (root) directory to sys.path so main.py can be found on Vercel Lambda
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import app
