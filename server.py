from flask import Flask, jsonify, request
import random
import string
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # To allow cross-origin requests, useful for your VSCode extension

# Route to simulate the /generate API call (for code completion suggestions)
@app.route('/generate', methods=['POST'])
def generate():
    try:
        data = request.get_json()
        print(f"Received request: {data}")  # This logs the request to the console

        # Simulate generating random completion suggestions
        suggestions = ["functionName()", "variableName", "forLoop()", "console.log()"]
        random_suggestions = random.sample(suggestions, len(suggestions))  # Shuffle suggestions
        return jsonify({'suggestions': random_suggestions})
    
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# Route to simulate the /chat API call (for generating chat messages)
@app.route('/chat', methods=['POST'])
def chat():
    data = request.json
    print("Received request:", data)  # Debugging
    if not data or 'message' not in data:
        return jsonify({'error': 'Invalid request'}), 400

    # Mock AI response for testing
    response_text = f"Echo: {data['message']}"

    return jsonify({'response': response_text})

# Route to simulate the /chat API call (for generating chat messages)
@app.route('/refactor', methods=['POST'])
def refactor():
    data = request.json
    print("Received request:", data)  # Debugging
    if not data:
        return jsonify({'error': 'Invalid request'}), 400

    # Mock AI response for testing
    response_text = data

    return jsonify({'response': response_text})

if __name__ == '__main__':
    app.run(debug=True, host='127.0.0.1', port=5000)
