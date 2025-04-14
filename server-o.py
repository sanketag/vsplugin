from flask import Flask, jsonify, request
import random
import string
import time
import json
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Helper functions
def random_id(length=6):
    return ''.join(random.choices(string.ascii_letters, k=length)).capitalize()

def random_word(length=5):
    return ''.join(random.choices(string.ascii_lowercase, k=length))

def generate_realistic_code(language_hint='python'):
    # Common programming patterns across languages
    base_patterns = [
        # Variables and literals
        lambda: f"{random_word()} = {random.randint(0, 100)}",
        lambda: f'result = "{random_word()}"',
        lambda: f"data = [{', '.join(str(random.randint(1,10)) for _ in range(3))}]",
        
        # Control structures
        lambda: f"if {random_word()} > {random.randint(0, 10)}:",
        lambda: f"for {random_word()} in {random_word()}:",
        lambda: f"while {random.choice(['True', 'False'])}:",
        
        # Error handling
        lambda: "try:\n    pass\nexcept Exception as e:\n    pass",
        
        # Function calls
        lambda: f"{random_word()}({', '.join(random_word() for _ in range(2))})",
    ]

    # Language-specific patterns
    language_patterns = {
        'python': [
            lambda: f"def {random_word()}({', '.join(random_word() for _ in range(2))}):",
            lambda: f"class {random_id()}:\n    def __init__(self):\n        pass",
            lambda: f"import {random_word()}",
            lambda: f"print(f'{{}}')",
        ],
        'javascript': [
            lambda: f"function {random_id()}() {{}}",
            lambda: f"const {random_word()} = () => {{}}",
            lambda: f"console.log(`${{{random_word()}}}`)",
            lambda: f"document.querySelector('.{random_word()}')",
            lambda: f"await {random_word()}.{random_word()}()",
        ],
        'html': [
            lambda: f"<div class='{random_word()}'>",
            lambda: f"<button onClick={{() => {random_word()}}}>",
            lambda: f"<input type='text' placeholder='{random_word()}'>",
        ]
    }

    # Combine patterns with weighted randomness
    all_patterns = base_patterns + language_patterns.get(language_hint, [])
    return random.choice(all_patterns)()

@app.route('/generate', methods=['POST'])
def generate():
    try:
        # Get language hint from request
        data = request.get_json()
        language_hint = data.get('language', 'python')
        
        # Generate 5-8 realistic code suggestions
        suggestions = [generate_realistic_code(language_hint) 
                      for _ in range(random.randint(5, 8))]
        
        return jsonify({
            'suggestions': suggestions,
            'language': language_hint,
            'count': len(suggestions)
        })

    except Exception as e:
        app.logger.error(f'Generation error: {str(e)}')
        return jsonify({
            'error': 'Failed to generate suggestions',
            'details': str(e)
        }), 500

@app.route('/chat', methods=['POST'])
def chat():
    try:
        data = request.get_json()
        if not data or 'message' not in data:
            return jsonify({'error': 'Message field required'}), 400

        # Generate more sophisticated mock responses
        responses = [
            f"Here's how you can {data['message']}: ...",
            f"Consider this approach:\n{generate_realistic_code()}",
            "Have you tried using a different algorithm?",
            f"Let me explain:\n1. First step\n2. {random_word().capitalize()}\n3. Implement solution"
        ]
        
        return jsonify({
            'response': random.choice(responses),
            'suggestions': [generate_realistic_code() for _ in range(2)]
        })

    except Exception as e:
        app.logger.error(f'Chat error: {str(e)}')
        return jsonify({'error': str(e)}), 500

@app.route('/refactor', methods=['POST'])
def refactor():
    try:
        data = request.get_json()
        if not data or 'code' not in data:
            return jsonify({'error': 'Code field required'}), 400

        # Simple mock refactoring
        original = data['code']
        refactored = original.replace('var_', 'improved_') + "\n# Refactored code"
        
        return jsonify({
            'original': original,
            'refactored': refactored,
            'changes': random.randint(1, 5)
        })

    except Exception as e:
        app.logger.error(f'Refactor error: {str(e)}')
        return jsonify({'error': str(e)}), 500

from flask import Response

@app.route('/chat/stream', methods=['POST'])
def chat_stream():
    def generate():
        try:
            data = request.get_json()
            message = data.get('message', '')
            context = data.get('context', [])
            
            # Simulate streaming response
            words = message.split()
            response_parts = [
                "Let me think about that...\n",
                *[f"{word.upper()} " for word in words],
                "\n\nHere's a code suggestion:\n",
                generate_realistic_code(),
                "\n\nDoes this help?"
            ]

            for part in response_parts:
                yield f"data: {json.dumps({'content': part})}\n\n"
                time.sleep(0.1)

        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        }
    )

if __name__ == '__main__':
    app.run(debug=True, host='127.0.0.1', port=5000)
