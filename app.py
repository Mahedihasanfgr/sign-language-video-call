import os
import cv2
import numpy as np
import pandas as pd
import pickle
import speech_recognition as sr
import mediapipe as mp
from PIL import Image
import base64
import io
import time
import json
import logging
import threading
from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize Flask app and SocketIO
app = Flask(__name__, static_folder='static')
app.config['SECRET_KEY'] = 'signlanguage123'
socketio = SocketIO(app, cors_allowed_origins="*")

# Store active rooms and users
active_rooms = {}
connected_users = {}

# Load sign language model
try:
    model_path = os.path.join('backend', 'sign_language_model3.pkl')
    with open(model_path, 'rb') as f:
        model_data = pickle.load(f)
    # Check if model is a dictionary and extract the actual model
    if isinstance(model_data, dict) and 'model' in model_data:
        model = model_data['model']
    else:
        model = model_data
    logger.info("Sign language model loaded successfully")
except Exception as e:
    logger.error(f"Failed to load model: {e}")
    model = None

# Initialize MediaPipe Hands
mp_hands = mp.solutions.hands
mp_drawing = mp.solutions.drawing_utils
hands = mp_hands.Hands(
    static_image_mode=False,
    max_num_hands=2,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5
)

# Routes
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/image/<filename>')
def serve_image(filename):
    return send_from_directory(os.path.join('backend', 'images'), filename)

# WebSocket event handlers
@socketio.on('connect')
def handle_connect():
    logger.info(f"Client connected: {request.sid}")
    connected_users[request.sid] = {'room': None}

@socketio.on('disconnect')
def handle_disconnect():
    logger.info(f"Client disconnected: {request.sid}")
    user = connected_users.get(request.sid)
    if user and user['room']:
        room_id = user['room']
        if room_id in active_rooms:
            active_rooms[room_id].remove(request.sid)
            if len(active_rooms[room_id]) == 0:
                del active_rooms[room_id]
            else:
                emit('user_left', {'sid': request.sid}, room=room_id)
    if request.sid in connected_users:
        del connected_users[request.sid]

@socketio.on('create_room')
def handle_create_room():
    # Generate a random room ID (in a real app, use a more secure method)
    room_id = str(int(time.time()))[-6:]
    active_rooms[room_id] = [request.sid]
    connected_users[request.sid]['room'] = room_id
    join_room(room_id)
    emit('room_created', {'room_id': room_id})
    logger.info(f"Room created: {room_id} by {request.sid}")

@socketio.on('join_room')
def handle_join_room(data):
    room_id = data['room_id']
    if room_id in active_rooms:
        if len(active_rooms[room_id]) < 2:  # Limit to 2 users per room
            active_rooms[room_id].append(request.sid)
            connected_users[request.sid]['room'] = room_id
            join_room(room_id)
            emit('room_joined', {'success': True, 'room_id': room_id})
            # Notify the other user
            for user_sid in active_rooms[room_id]:
                if user_sid != request.sid:
                    emit('user_joined', {'sid': request.sid}, room=user_sid)
            logger.info(f"User {request.sid} joined room {room_id}")
        else:
            emit('room_joined', {'success': False, 'message': 'Room is full'})
    else:
        emit('room_joined', {'success': False, 'message': 'Room not found'})

@socketio.on('ice_candidate')
def handle_ice_candidate(data):
    room_id = connected_users.get(request.sid, {}).get('room')
    if not room_id:
        return
    
    # Forward the ICE candidate to the other user in the room
    for user_sid in active_rooms.get(room_id, []):
        if user_sid != request.sid:
            emit('ice_candidate', {
                'candidate': data['candidate']
            }, room=user_sid)

@socketio.on('offer')
def handle_offer(data):
    room_id = connected_users.get(request.sid, {}).get('room')
    if not room_id:
        return
    
    # Forward the offer to the other user in the room
    for user_sid in active_rooms.get(room_id, []):
        if user_sid != request.sid:
            emit('offer', {
                'offer': data['offer']
            }, room=user_sid)

@socketio.on('answer')
def handle_answer(data):
    room_id = connected_users.get(request.sid, {}).get('room')
    if not room_id:
        return
    
    # Forward the answer to the other user in the room
    for user_sid in active_rooms.get(room_id, []):
        if user_sid != request.sid:
            emit('answer', {
                'answer': data['answer']
            }, room=user_sid)

@socketio.on('video_frame')
def handle_video_frame(data):
    room_id = connected_users.get(request.sid, {}).get('room')
    if not room_id:
        return
    
    frame_data = data['frame']
    # Process the frame for sign language detection
    try:
        # Decode the base64 image
        frame_bytes = base64.b64decode(frame_data.split(',')[1])
        frame_array = np.frombuffer(frame_bytes, dtype=np.uint8)
        frame = cv2.imdecode(frame_array, cv2.IMREAD_COLOR)
        
        # Process with MediaPipe
        results, detected_sign, confidence = process_frame_for_detection(frame)
        
        # Encode the processed frame with landmarks
        processed_frame = visualize_landmarks(frame, results, detected_sign)
        _, buffer = cv2.imencode('.jpg', processed_frame)
        processed_frame_data = base64.b64encode(buffer).decode('utf-8')
        
        # Send the detected sign back to the sender
        emit('sign_detected', {'sign': detected_sign, 'confidence': confidence}, room=request.sid)
        
        # Send the processed frame and detected sign to the other users in the room
        for user_sid in active_rooms[room_id]:
            if user_sid != request.sid:
                emit('video_frame', {
                    'frame': f"data:image/jpeg;base64,{processed_frame_data}",
                    'sender': request.sid,
                    'detected_sign': detected_sign,
                    'confidence': confidence
                }, room=user_sid)
    except Exception as e:
        logger.error(f"Error processing video frame: {e}")

@socketio.on('chat_message')
def handle_chat_message(data):
    room_id = connected_users.get(request.sid, {}).get('room')
    if not room_id:
        return
    for user_sid in active_rooms.get(room_id, []):
        if user_sid != request.sid:
            emit('chat_message', {'message': data['message'], 'time': data.get('time', '')}, room=user_sid)

@socketio.on('speech_to_sign')
def handle_speech_to_sign(data):
    room_id = connected_users.get(request.sid, {}).get('room')
    if not room_id:
        return
    
    text = data['text']
    # Process text for speech to sign conversion
    logger.info(f"Converting speech to sign: {text}")
    
    # Get sign language images with word information
    image_paths, word_info = get_sign_images(text)
    
    # Send image paths and word info to both users in the room
    emit('speech_to_sign_result', {
        'text': text,
        'images': image_paths,
        'word_info': word_info
    }, room=room_id)

# Helper functions
def calculate_angle(a, b, c):
    a = np.array(a)
    b = np.array(b)
    c = np.array(c)
    radians = np.arctan2(c[1] - b[1], c[0] - b[0]) - np.arctan2(a[1] - b[1], a[0] - b[0])
    angle = np.abs(radians * 180.0 / np.pi)
    return angle if angle <= 180.0 else 360 - angle

def extract_features(landmarks, img_width, img_height):
    """
    Extract features from hand landmarks, matching the method in train3.py
    
    Parameters:
    landmarks -- MediaPipe hand landmarks
    img_width -- image width
    img_height -- image height
    
    Returns:
    features -- list of extracted features
    """
    # Extract normalized coordinates (MediaPipe already provides normalized coords)
    landmark_points_norm = []
    for landmark in landmarks.landmark:
        # Store the normalized coordinates
        landmark_points_norm.append((landmark.x, landmark.y, landmark.z))
        
    # Extract 2D coordinates for feature extraction
    landmark_points_2d = [(point[0], point[1]) for point in landmark_points_norm]
    
    # Get hand size (distance from wrist to middle finger MCP)
    # Used for normalization
    hand_size = np.linalg.norm(
        np.array([landmark_points_norm[9][0] - landmark_points_norm[0][0],
                 landmark_points_norm[9][1] - landmark_points_norm[0][1]])
    )
    
    features = []
    
    # 1. Relative Distances (6 features) - Key distances in the hand
    # Normalized by hand size to be resolution independent
    distance_pairs = [(0, 8), (0, 12), (0, 16), (0, 20), (4, 8), (8, 20)]
    for start, end in distance_pairs:
        dist = np.linalg.norm(np.array(landmark_points_2d[start]) - np.array(landmark_points_2d[end]))
        # Normalize by hand size
        norm_dist = dist / hand_size if hand_size > 0 else 0
        features.append(norm_dist)
    
    # 2. Landmark Angles (5 features) - Key angles in the hand
    # Angles are already resolution independent
    angle_triplets = [(0, 5, 8), (0, 9, 12), (0, 13, 16), (0, 17, 20), (5, 9, 13)]
    for a, b, c in angle_triplets:
        angle = calculate_angle(
            landmark_points_2d[a], 
            landmark_points_2d[b], 
            landmark_points_2d[c]
        )
        features.append(angle)
    
    # 3. Bounding Box (4 features)
    # We use normalized coordinates directly
    x_coords = [point[0] for point in landmark_points_2d]
    y_coords = [point[1] for point in landmark_points_2d]
    bbox = [min(x_coords), min(y_coords), max(x_coords), max(y_coords)]
    features.extend(bbox)
    
    # 4. Finger Spreads (4 features) - Distance between adjacent fingertips
    # Normalized by hand size to be resolution independent
    finger_tips = [4, 8, 12, 16, 20]
    for i in range(len(finger_tips) - 1):
        spread = np.linalg.norm(np.array(landmark_points_2d[finger_tips[i]]) - 
                                np.array(landmark_points_2d[finger_tips[i+1]]))
        # Normalize by hand size
        norm_spread = spread / hand_size if hand_size > 0 else 0
        features.append(norm_spread)
    
    # 5. Hand Orientation (2 features)
    # Angles are already resolution independent
    wrist_to_middle = np.array(landmark_points_2d[9]) - np.array(landmark_points_2d[0])
    orientation = np.arctan2(wrist_to_middle[1], wrist_to_middle[0])
    features.append(orientation)
    
    wrist_to_index = np.array(landmark_points_2d[5]) - np.array(landmark_points_2d[0])
    orientation2 = np.arctan2(wrist_to_index[1], wrist_to_index[0])
    features.append(orientation2)
    
    # 6. Finger Flexion (5 features) - Bend angle for each finger
    # Angles are already resolution independent
    for finger_base in [1, 5, 9, 13, 17]:  # Base joints of each finger
        # Calculate the angle between three consecutive points on the finger
        flexion = calculate_angle(
            landmark_points_2d[finger_base], 
            landmark_points_2d[finger_base+1], 
            landmark_points_2d[finger_base+2]
        )
        features.append(flexion)
    
    # 7. Finger Tip to Palm Distances (5 features)
    # Normalized by hand size to be resolution independent
    palm_center = np.mean([landmark_points_2d[i] for i in [0, 5, 9, 13, 17]], axis=0)
    for tip in [4, 8, 12, 16, 20]:  # Finger tips
        dist = np.linalg.norm(np.array(landmark_points_2d[tip]) - palm_center)
        # Normalize by hand size
        norm_dist = dist / hand_size if hand_size > 0 else 0
        features.append(norm_dist)
    
    # 8. 3D Depth Features (3 features)
    # Normalize Z values relative to hand size
    z_values = [point[2] for point in landmark_points_norm]
    z_range = max(z_values) - min(z_values)
    features.append(z_range / hand_size if hand_size > 0 else 0)  # Z-range
    features.append(np.mean(z_values) / hand_size if hand_size > 0 else 0)  # Mean Z
    features.append(np.std(z_values) / hand_size if hand_size > 0 else 0)   # Z standard deviation
    
    return features

def process_frame_for_detection(frame):
    if model is None:
        return None, "Model not loaded", None
    
    # Convert to RGB (MediaPipe requires RGB input)
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    
    # Process the frame
    results = hands.process(rgb_frame)
    
    detected_sign = None
    confidence = None
    if results.multi_hand_landmarks and results.multi_handedness:
        img_height, img_width, _ = frame.shape
        
        right_hand_features = None
        left_hand_features = None
        right_hand_present = 0
        left_hand_present = 0
        
        # Extract features for each hand
        for hand_landmarks, handedness in zip(results.multi_hand_landmarks, results.multi_handedness):
            is_right_hand = handedness.classification[0].label == "Right"
            
            features = extract_features(hand_landmarks, img_width, img_height)
            
            if is_right_hand:
                right_hand_features = features
                right_hand_present = 1
            else:
                left_hand_features = features
                left_hand_present = 1
        
        # Determine if this is potentially a double hand sign
        is_double_hand = (right_hand_present and left_hand_present)
        
        # Prepare feature row (similar to training data structure)
        combined_features = [int(is_double_hand)]  # Include Is_Double_Hand flag
        
        # Add right hand data
        combined_features.append(right_hand_present)
        if right_hand_features:
            combined_features.extend(right_hand_features)
        else:
            combined_features.extend([0] * 34)  # 34 features per hand
        
        # Add left hand data
        combined_features.append(left_hand_present)
        if left_hand_features:
            combined_features.extend(left_hand_features)
        else:
            combined_features.extend([0] * 34)  # 34 features per hand
        
        confidence = None
        try:
            # Reshape features to match the model's expected input
            features_array = np.array(combined_features).reshape(1, -1)
            
            # Make prediction
            prediction = model.predict(features_array)
            detected_sign = prediction[0] if isinstance(prediction, (list, np.ndarray)) else prediction
            logger.info(f"Detected sign: {detected_sign}")

            if hasattr(model, 'predict_proba'):
                proba = model.predict_proba(features_array)
                confidence = float(np.max(proba))
        except Exception as e:
            logger.error(f"Prediction error: {e}")
            logger.error(f"Features shape: {np.array(combined_features).shape}")
            logger.error(f"Model type: {type(model)}")
    
    return results, detected_sign, confidence

def visualize_landmarks(frame, results, detected_sign=None):
    frame_out = frame.copy()
    return frame_out

def get_sign_images(text):
    """Get sign language images for the given text"""
    image_paths = []
    word_info = []  # To track which images belong to which words
    image_dir = os.path.join('backend', 'images')
    
    # Check for whole phrases first
    if os.path.exists(os.path.join(image_dir, f"{text.lower()}.png")):
        image_paths.append(f"/image/{text.lower()}.png")
        word_info.append({"word": text.lower(), "type": "word"})
        return image_paths, word_info
    
    # Process individual words
    words = text.split()
    for word_idx, word in enumerate(words):
        word_lower = word.lower()
        word_path = os.path.join(image_dir, f"{word_lower}.png")
        
        # Track the current word being processed
        current_word_info = {"word": word_lower, "type": "word"}
        
        # Check if word image exists
        if os.path.exists(word_path):
            image_paths.append(f"/image/{word_lower}.png")
            word_info.append(current_word_info)
        else:
            # Process individual characters
            for char_idx, char in enumerate(word):
                if char.isalnum():  # Only process alphanumeric characters
                    char_upper = char.upper()
                    char_path = os.path.join(image_dir, f"{char_upper}.png")
                    if os.path.exists(char_path):
                        image_paths.append(f"/image/{char_upper}.png")
                        word_info.append({
                            "word": word_lower, 
                            "type": "character", 
                            "character": char_upper,
                            "is_last": char_idx == len(word) - 1
                        })
    
    return image_paths, word_info

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, debug=False, host='0.0.0.0', port=port)