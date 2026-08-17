/* ==========================================================================
   OSHA AI - Supabase & Mock Database Client (Production Ready)
   ========================================================================== */

(function () {

    let supabase = null;
    let adminSupabase = null;

    // Initialize Supabase if configuration parameters are present
    const url = typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : (typeof window !== 'undefined' ? window.SUPABASE_URL : undefined);
    const anon = typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : (typeof window !== 'undefined' ? window.SUPABASE_ANON_KEY : undefined);
    const service = typeof SUPABASE_SERVICE_ROLE_KEY !== 'undefined' ? SUPABASE_SERVICE_ROLE_KEY : (typeof window !== 'undefined' ? window.SUPABASE_SERVICE_ROLE_KEY : undefined);

    if (url && anon) {
        try {
            if (window.supabase && window.supabase.createClient) {
                if (window._globalSupabaseInstance) {
                    supabase = window._globalSupabaseInstance;
                } else {
                    supabase = window.supabase.createClient(url, anon);
                    window._globalSupabaseInstance = supabase;
                }
                if (service) {
                    adminSupabase = window._globalAdminSupabaseInstance || window.supabase.createClient(url, service);
                    window._globalAdminSupabaseInstance = adminSupabase;
                }
                console.log("Supabase Client initialized successfully.");
            } else {
                console.warn("window.supabase.createClient is not available. Using simulator mode.");
            }
        } catch (e) {
            console.warn("Failed to initialize Supabase client, falling back to Local Simulator. Error:", e);
        }
    }

    // --------------------------------------------------------------------------
    // Local Storage Database Engine (Fallback Simulation Mode)
    // --------------------------------------------------------------------------
    class LocalStorageDatabase {
        constructor() {
            this.initDefaultStorage();
            this.startSimulationEngine();
        }

        initDefaultStorage() {
            if (!localStorage.getItem('osha_users')) localStorage.setItem('osha_users', JSON.stringify({}));
            if (!localStorage.getItem('osha_profiles')) localStorage.setItem('osha_profiles', JSON.stringify({}));
            if (!localStorage.getItem('osha_settings')) localStorage.setItem('osha_settings', JSON.stringify({}));
            if (!localStorage.getItem('osha_cameras')) localStorage.setItem('osha_cameras', JSON.stringify([]));
            if (!localStorage.getItem('osha_prompts')) localStorage.setItem('osha_prompts', JSON.stringify([]));
            if (!localStorage.getItem('osha_detections')) localStorage.setItem('osha_detections', JSON.stringify([]));
            if (!localStorage.getItem('osha_subscriptions')) localStorage.setItem('osha_subscriptions', JSON.stringify({}));

            // Seed default detections if empty
            const detections = JSON.parse(localStorage.getItem('osha_detections'));
            if (detections.length === 0) {
                const seedDetections = [
                    {
                        id: 'd1',
                        camera_id: 'c1',
                        user_id: 'simulated-user',
                        snapshot_url: '',
                        reason: 'Package Delivered: Large Amazon box placed on door mat.',
                        confidence: 98.40,
                        status: 'Unread',
                        timestamp: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
                        created_at: new Date(Date.now() - 1000 * 60 * 20).toISOString()
                    },
                    {
                        id: 'd2',
                        camera_id: 'c2',
                        user_id: 'simulated-user',
                        snapshot_url: '',
                        reason: 'Forklift detected in warehouse Aisle 5 loading dock area.',
                        confidence: 96.80,
                        status: 'Unread',
                        timestamp: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
                        created_at: new Date(Date.now() - 1000 * 60 * 120).toISOString()
                    },
                    {
                        id: 'd3',
                        camera_id: 'c3',
                        user_id: 'simulated-user',
                        snapshot_url: '',
                        reason: 'Canine object detected on Sofa. Boundary intersection 92%.',
                        confidence: 95.10,
                        status: 'Read',
                        timestamp: new Date(Date.now() - 1000 * 60 * 360).toISOString(),
                        created_at: new Date(Date.now() - 1000 * 60 * 360).toISOString()
                    }
                ];
                localStorage.setItem('osha_detections', JSON.stringify(seedDetections));
            }

            // Seed default cameras if empty
            const cameras = JSON.parse(localStorage.getItem('osha_cameras'));
            if (cameras.length === 0) {
                const seedCameras = [
                    {
                        id: 'c1',
                        user_id: 'simulated-user',
                        name: 'Front Door Cam',
                        location: 'Porch Entrance',
                        rtsp_url: 'rtsp://192.168.1.50/stream1',
                        username: 'admin',
                        password_encrypted: 'bW9ja19wYXNz',
                        status: 'Online',
                        connection_quality: 'Excellent',
                        detection_interval: 5,
                        created_at: new Date(Date.now() - 1000 * 3600 * 24 * 5).toISOString()
                    },
                    {
                        id: 'c2',
                        user_id: 'simulated-user',
                        name: 'Warehouse Loading Bay 3',
                        location: 'Industrial Area',
                        rtsp_url: 'rtsp://10.0.0.12/live',
                        username: 'operator',
                        password_encrypted: 'c2VjdXJlX2xvZ2lu',
                        status: 'Online',
                        connection_quality: 'Good',
                        detection_interval: 10,
                        created_at: new Date(Date.now() - 1000 * 3600 * 24 * 10).toISOString()
                    },
                    {
                        id: 'c3',
                        user_id: 'simulated-user',
                        name: 'Living Room Monitor',
                        location: 'Indoor Lounge',
                        rtsp_url: 'rtsp://192.168.1.80/high',
                        username: 'family',
                        password_encrypted: 'cGFzc3dvcmQxMjM=',
                        status: 'Online',
                        connection_quality: 'Excellent',
                        detection_interval: 5,
                        created_at: new Date(Date.now() - 1000 * 3600 * 24 * 2).toISOString()
                    }
                ];
                localStorage.setItem('osha_cameras', JSON.stringify(seedCameras));

                // Seed prompts matching seed cameras
                const seedPrompts = [
                    { id: 'p1', camera_id: 'c1', user_id: 'simulated-user', prompt_text: 'Notify me when someone approaches the door.', created_at: new Date().toISOString() },
                    { id: 'p2', camera_id: 'c2', user_id: 'simulated-user', prompt_text: 'Notify me if the warehouse loading dock is blocked.', created_at: new Date().toISOString() },
                    { id: 'p3', camera_id: 'c3', user_id: 'simulated-user', prompt_text: 'Alert me when my dog jumps onto the couch.', created_at: new Date().toISOString() }
                ];
                localStorage.setItem('osha_prompts', JSON.stringify(seedPrompts));
            }
        }

        // Active AI generation loop: generates mock camera detection logs periodically
        startSimulationEngine() {
            setInterval(() => {
                const session = this.getCurrentSession();
                if (!session) return;

                const cameras = JSON.parse(localStorage.getItem('osha_cameras')).filter(c => c.user_id === session.user.id && c.status === 'Online');
                if (cameras.length === 0) return;

                // Pick a random camera
                const camera = cameras[Math.floor(Math.random() * cameras.length)];
                const prompts = JSON.parse(localStorage.getItem('osha_prompts')).filter(p => p.camera_id === camera.id);
                const promptText = prompts.length > 0 ? prompts[prompts.length - 1].prompt_text : 'Detecting movements...';

                let reason = `Movement detected matching rule: "${promptText}"`;
                if (promptText.toLowerCase().includes('door')) {
                    const events = [
                        "Visitor detected: Person standing in front porch waiting.",
                        "Package Delivered: USPS courier dropped off medium parcel.",
                        "Amazon Delivery Person detected walking back to vehicle."
                    ];
                    reason = events[Math.floor(Math.random() * events.length)];
                } else if (promptText.toLowerCase().includes('dock') || promptText.toLowerCase().includes('warehouse')) {
                    const events = [
                        "Industrial obstacle check: Loading ramp blocked by pallets.",
                        "Forklift activity: Worker driving forklift into main aisle.",
                        "Safety breach: Loading dock gate remained open without vehicle present."
                    ];
                    reason = events[Math.floor(Math.random() * events.length)];
                } else if (promptText.toLowerCase().includes('dog') || promptText.toLowerCase().includes('couch')) {
                    const events = [
                        "Pet behavior: Dog jumped onto sofa.",
                        "Pet status: Dog sleeping in dog bed.",
                        "Pet tracking: Dog entered kitchen area."
                    ];
                    reason = events[Math.floor(Math.random() * events.length)];
                }

                const confidence = parseFloat((92 + Math.random() * 7.5).toFixed(2));

                const newDetection = {
                    id: 'det-' + Math.random().toString(36).substr(2, 9),
                    camera_id: camera.id,
                    user_id: session.user.id,
                    snapshot_url: '',
                    reason: reason,
                    confidence: confidence,
                    status: 'Unread',
                    timestamp: new Date().toISOString(),
                    created_at: new Date().toISOString()
                };

                const detections = JSON.parse(localStorage.getItem('osha_detections'));
                detections.unshift(newDetection);
                localStorage.setItem('osha_detections', JSON.stringify(detections));

                // Fire window custom event for live listeners
                const event = new CustomEvent('osha-live-detection', { detail: { detection: newDetection, cameraName: camera.name } });
                window.dispatchEvent(event);

            }, 30000); // Trigger mock detection every 30 seconds
        }

        getCurrentSession() {
            const sessionJson = localStorage.getItem('osha_session');
            return sessionJson ? JSON.parse(sessionJson) : null;
        }

        signUp(email, password, fullName) {
            const users = JSON.parse(localStorage.getItem('osha_users'));
            if (users[email]) {
                return { error: { message: "User already exists." } };
            }

            const userId = 'user-' + Math.random().toString(36).substr(2, 9);
            users[email] = { id: userId, email, password, fullName };
            localStorage.setItem('osha_users', JSON.stringify(users));

            // Create Profile, Settings, and Subscriptions records
            const profiles = JSON.parse(localStorage.getItem('osha_profiles'));
            profiles[userId] = {
                id: userId,
                full_name: fullName || email.split('@')[0],
                email: email,
                avatar_url: '',
                subscription_plan: 'Free',
                subscription_status: 'Active',
                created_at: new Date().toISOString()
            };
            localStorage.setItem('osha_profiles', JSON.stringify(profiles));

            const settings = JSON.parse(localStorage.getItem('osha_settings'));
            settings[userId] = {
                id: 'settings-' + userId,
                user_id: userId,
                timezone: 'UTC',
                theme: 'light',
                email_notifications: true,
                notification_cooldown: 60,
                daily_summary: false,
                created_at: new Date().toISOString()
            };
            localStorage.setItem('osha_settings', JSON.stringify(settings));

            return { data: { user: { id: userId, email } }, error: null };
        }

        signIn(email, password) {
            // Fallback check: if email is dummy and empty users database, register instantly to ease testing!
            const users = JSON.parse(localStorage.getItem('osha_users'));
            let user = users[email];

            if (!user && email === "demo@osha.ai") {
                // Auto register the developer preview credentials
                this.signUp(email, "password", "Demo Account");
                user = JSON.parse(localStorage.getItem('osha_users'))[email];
            }

            if (!user || user.password !== password) {
                return { error: { message: "Invalid login credentials." } };
            }

            const session = {
                access_token: 'mock-token-' + Math.random().toString(36).substr(2, 9),
                user: { id: user.id, email: user.email }
            };
            localStorage.setItem('osha_session', JSON.stringify(session));
            return { data: { session, user: session.user }, error: null };
        }

        signOut() {
            localStorage.removeItem('osha_session');
            return { error: null };
        }
    }

    const mockDb = new LocalStorageDatabase();

    // --------------------------------------------------------------------------
    // Unified Database Wrapper Interface
    // --------------------------------------------------------------------------
    const dbClient = {
        // 1. Auth Module
        auth: {
            async signUp(email, password, fullName) {
                if (supabase) {
                    const { data, error } = await supabase.auth.signUp({
                        email,
                        password,
                        options: { data: { full_name: fullName } }
                    });
                    return { data, error };
                }
                return mockDb.signUp(email, password, fullName);
            },

            async signInWithGoogle() {
                if (supabase) {
                    const { data, error } = await supabase.auth.signInWithOAuth({
                        provider: 'google',
                        options: {
                            redirectTo: window.location.origin + '/dashboard.html'
                        }
                    });
                    return { data, error };
                }
                return mockDb.signIn("demo@osha.ai", "password");
            },

            async signIn(email, password) {
                if (supabase) {
                    let { data, error } = await supabase.auth.signInWithPassword({ email, password });
                    // Auto-register demo account in real Supabase if it doesn't exist
                    if (error && email === "demo@osha.ai" && error.message.includes("Invalid login")) {
                        const { data: signUpData } = await supabase.auth.signUp({ email, password, options: { data: { full_name: "Demo Account" } } });
                        if (signUpData && signUpData.user) {
                            await supabase.from('cameras').insert([{
                                user_id: signUpData.user.id,
                                name: 'FRONT CAM',
                                location: 'Front Gate',
                                rtsp_url: 'webcam://0',
                                status: 'Online',
                                connection_quality: 'Excellent',
                                detection_interval: 5
                            }]);
                        }
                        const res = await supabase.auth.signInWithPassword({ email, password });
                        data = res.data;
                        error = res.error;
                    }
                    return { data, error };
                }
                return mockDb.signIn(email, password);
            },

            async signOut() {
                if (supabase) {
                    const { error } = await supabase.auth.signOut();
                    return { error };
                }
                return mockDb.signOut();
            },

            async getSession() {
                if (supabase) {
                    const { data, error } = await supabase.auth.getSession();
                    return { session: data.session, error };
                }
                const session = mockDb.getCurrentSession();
                return { session, error: null };
            },

            onAuthStateChange(callback) {
                if (supabase) {
                    return supabase.auth.onAuthStateChange(callback);
                }
                // Mock auth states listener hooks
                window.addEventListener('osha-auth-state-changed', () => {
                    const session = mockDb.getCurrentSession();
                    callback(session ? 'SIGNED_IN' : 'SIGNED_OUT', session);
                });
                // Initial call
                setTimeout(() => {
                    const session = mockDb.getCurrentSession();
                    callback(session ? 'INITIAL_SESSION' : 'SIGNED_OUT', session);
                }, 100);
                return { data: { subscription: { unsubscribe() { } } } };
            }
        },

        // 2. Profiles Table Queries
        async getProfile(userId) {
            if (supabase) {
                const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).order('created_at', { ascending: false }).limit(1);
                return { data: data && data.length > 0 ? data[0] : null, error };
            }
            const profiles = JSON.parse(localStorage.getItem('osha_profiles'));
            return { data: profiles[userId] || null, error: null };
        },

        async updateProfile(userId, updates) {
            console.log("updateProfile called. adminSupabase exists?", !!adminSupabase);
            const client = adminSupabase || supabase;
            if (client) {
                const { data: existingList } = await client.from('profiles').select('id').eq('id', userId).limit(1);
                if (existingList && existingList.length > 0) {
                    const { data, error } = await client.from('profiles').update(updates).eq('id', userId).select();
                    return { data: data ? data[0] : null, error };
                } else {
                    const { data: { session } } = await client.auth.getSession();
                    const email = session?.user?.email || 'legacy@osha.ai';
                    const { data, error } = await client.from('profiles').insert({ id: userId, email: email, ...updates }).select();
                    return { data: data ? data[0] : null, error };
                }
            }
            const profiles = JSON.parse(localStorage.getItem('osha_profiles'));
            if (profiles[userId]) {
                profiles[userId] = { ...profiles[userId], ...updates };
                localStorage.setItem('osha_profiles', JSON.stringify(profiles));
                return { data: profiles[userId], error: null };
            }
            return { data: null, error: { message: "Profile not found" } };
        },

        // 2.5 Subscriptions Table Queries
        // 2.5 Subscriptions Table Queries
        async getSubscription(userId) {
            if (supabase) {
                const { data, error } = await supabase.from('subscriptions').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(1);

                // If no subscription exists, default to Free
                if (!data || data.length === 0) {
                    return { data: { plan_name: 'Free', subscription_status: 'active' }, error: null };
                }

                // Enforce expiry logic locally for simulator (backend does this securely in production)
                const sub = data[0];
                if (sub.end_date && new Date(sub.end_date) < new Date() && sub.subscription_status === 'active' && sub.plan_name !== 'Free') {
                    // It has expired but hasn't been picked up by a webhook or cron yet. Treat as Free locally.
                    return { data: { ...sub, plan_name: 'Free', subscription_status: 'expired' }, error: null };
                }

                return { data: sub, error };
            }
            return { data: { plan_name: 'Free', subscription_status: 'active' }, error: null };
        },

        async updateSubscription(userId, updates) {
            const client = adminSupabase || supabase;
            if (client) {
                const { data: existingList } = await client.from('subscriptions').select('id').eq('user_id', userId).limit(1);

                if (existingList && existingList.length > 0) {
                    const { data, error } = await client.from('subscriptions').update(updates).eq('user_id', userId).select();
                    return { data: data ? data[0] : null, error };
                } else {
                    const { data, error } = await client.from('subscriptions').insert({ user_id: userId, ...updates }).select();
                    return { data: data ? data[0] : null, error };
                }
            }
            return { data: { ...updates }, error: null };
        },

        async downgradeToFree(userId) {
            const updates = {
                plan_name: 'Free',
                subscription_status: 'active',
                billing_interval: null,
                start_date: new Date().toISOString(),
                end_date: null,
                next_billing_date: null
            };
            await this.updateProfile(userId, { subscription_plan: 'Free' });
            return await this.updateSubscription(userId, updates);
        },

        // 3. Settings Table Queries
        async getSettings(userId) {
            if (supabase) {
                const { data, error } = await supabase.from('settings').select('*').eq('user_id', userId).single();
                return { data, error };
            }
            const settings = JSON.parse(localStorage.getItem('osha_settings'));
            return { data: settings[userId] || null, error: null };
        },

        async updateSettings(userId, updates) {
            if (supabase) {
                const { data, error } = await supabase.from('settings').update(updates).eq('user_id', userId).select().single();
                return { data, error };
            }
            const settings = JSON.parse(localStorage.getItem('osha_settings'));
            if (settings[userId]) {
                settings[userId] = { ...settings[userId], ...updates };
                localStorage.setItem('osha_settings', JSON.stringify(settings));
                return { data: settings[userId], error: null };
            }
            return { data: null, error: { message: "Settings profile not found" } };
        },

        // 4. Cameras Table CRUD
        async getCameras(userId) {
            if (supabase) {
                const { data, error } = await supabase.from('cameras').select('*').eq('user_id', userId).order('created_at', { ascending: false });
                return { data, error };
            }
            const cameras = JSON.parse(localStorage.getItem('osha_cameras')).filter(c => c.user_id === userId);
            return { data: cameras, error: null };
        },

        async addCamera(camera) {
            if (supabase) {
                const { data, error } = await supabase.from('cameras').insert([camera]).select().single();
                return { data, error };
            }
            const cameras = JSON.parse(localStorage.getItem('osha_cameras'));
            const newCamera = {
                id: 'cam-' + Math.random().toString(36).substr(2, 9),
                status: 'Online',
                connection_quality: 'Excellent',
                routine_learning_enabled: false,
                created_at: new Date().toISOString(),
                ...camera
            };
            cameras.unshift(newCamera);
            localStorage.setItem('osha_cameras', JSON.stringify(cameras));
            return { data: newCamera, error: null };
        },

        async updateCamera(cameraId, userId, updates) {
            if (supabase) {
                const { data, error } = await supabase.from('cameras').update(updates).eq('id', cameraId).eq('user_id', userId).select().single();
                return { data, error };
            }
            const cameras = JSON.parse(localStorage.getItem('osha_cameras'));
            const idx = cameras.findIndex(c => c.id === cameraId && c.user_id === userId);
            if (idx !== -1) {
                cameras[idx] = { ...cameras[idx], ...updates };
                localStorage.setItem('osha_cameras', JSON.stringify(cameras));
                return { data: cameras[idx], error: null };
            }
            return { data: null, error: { message: "Camera not found or access denied." } };
        },

        async deleteCamera(cameraId, userId) {
            if (supabase) {
                const { error } = await supabase.from('cameras').delete().eq('id', cameraId).eq('user_id', userId);
                if (!error) {
                    try {
                        await fetch(`${window.API_BASE_URL}/api/engine/delete`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ camId: cameraId })
                        });
                    } catch (e) { console.warn("Could not notify backend of camera deletion", e); }
                }
                return { error };
            }
            let cameras = JSON.parse(localStorage.getItem('osha_cameras'));
            const initialLen = cameras.length;
            cameras = cameras.filter(c => !(c.id === cameraId && c.user_id === userId));
            localStorage.setItem('osha_cameras', JSON.stringify(cameras));
            return { error: cameras.length < initialLen ? null : { message: "Camera not found." } };
        },


        // Delete all detections/alerts for a specific camera (called on camera delete)
        async deleteDetectionsForCamera(cameraId, userId) {
            if (supabase) {
                const { error } = await supabase
                    .from('detections')
                    .delete()
                    .eq('camera_id', cameraId)
                    .eq('user_id', userId);
                return { error };
            }
            // Mock: remove from localStorage
            let detections = JSON.parse(localStorage.getItem('osha_detections') || '[]');
            detections = detections.filter(d => !(d.camera_id === cameraId && d.user_id === userId));
            localStorage.setItem('osha_detections', JSON.stringify(detections));
            return { error: null };
        },

        // 5. Prompts Table
        async getPromptsForCamera(cameraId, userId) {
            if (supabase) {
                const { data, error } = await supabase.from('camera_prompts').select('*').eq('camera_id', cameraId).eq('user_id', userId).order('created_at', { ascending: false });
                return { data, error };
            }
            const prompts = JSON.parse(localStorage.getItem('osha_prompts')).filter(p => p.camera_id === cameraId && p.user_id === userId);
            prompts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            return { data: prompts, error: null };
        },

        async addPrompt(prompt) {
            if (supabase) {
                const { data, error } = await supabase.from('camera_prompts').insert([prompt]).select().single();
                if (error) throw new Error(error.message);
                return { data, error };
            }
            const prompts = JSON.parse(localStorage.getItem('osha_prompts'));
            const newPrompt = {
                id: 'prompt-' + Math.random().toString(36).substr(2, 9),
                created_at: new Date().toISOString(),
                ...prompt
            };
            prompts.push(newPrompt);
            localStorage.setItem('osha_prompts', JSON.stringify(prompts));
            return { data: newPrompt, error: null };
        },

        // 6. Detections Table CRUD
        async getDetections(userId) {
            if (!userId) return { data: [], error: null };
            if (supabase) {
                const { data, error } = await supabase
                    .from('detections')
                    .select('*, cameras(name)')
                    .eq('user_id', userId)
                    .order('timestamp', { ascending: false })
                    .limit(100);
                return { data: data || [], error };
            }
            // Mock: only return detections that truly belong to this user
            const detections = JSON.parse(localStorage.getItem('osha_detections') || '[]')
                .filter(d => d.user_id === userId);
            const cameras = JSON.parse(localStorage.getItem('osha_cameras') || '[]');
            const mappedDetections = detections.map(d => {
                const cam = cameras.find(c => c.id === d.camera_id);
                return {
                    ...d,
                    cameras: { name: cam ? cam.name : 'Unknown Camera' }
                };
            });
            return { data: mappedDetections, error: null };
        },

        async updateDetectionStatus(detectionId, userId, updates) {
            if (supabase) {
                const { data, error } = await supabase.from('detections').update(updates).eq('id', detectionId).eq('user_id', userId).select().single();
                return { data, error };
            }
            const detections = JSON.parse(localStorage.getItem('osha_detections'));
            const idx = detections.findIndex(d => d.id === detectionId && d.user_id === userId);
            if (idx !== -1) {
                detections[idx] = { ...detections[idx], ...updates };
                localStorage.setItem('osha_detections', JSON.stringify(detections));
                return { data: detections[idx], error: null };
            }
            return { data: null, error: { message: "Detection log not found." } };
        },

        async deleteDetection(detectionId, userId) {
            if (supabase) {
                const { error } = await supabase.from('detections').delete().eq('id', detectionId).eq('user_id', userId);
                return { error };
            }
            let detections = JSON.parse(localStorage.getItem('osha_detections'));
            detections = detections.filter(d => !(d.id === detectionId && d.user_id === userId));
            localStorage.setItem('osha_detections', JSON.stringify(detections));
            return { error: null };
        },

        async addDetection(detectionData) {
            if (supabase) {
                const { data, error } = await supabase.from('detections').insert([detectionData]).select().single();
                return { data, error };
            }
            // LocalStorage fallback
            const detections = JSON.parse(localStorage.getItem('osha_detections') || '[]');
            const newDetection = {
                id: 'd_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
                ...detectionData
            };
            detections.unshift(newDetection);
            localStorage.setItem('osha_detections', JSON.stringify(detections));
            // Fire live detection event
            const event = new CustomEvent('osha-live-detection', { detail: { detection: newDetection } });
            window.dispatchEvent(event);
            return { data: newDetection, error: null };
        },

        async getDetectionsForCamera(cameraId, userId) {
            if (supabase) {
                const { data, error } = await supabase.from('detections')
                    .select('*')
                    .eq('camera_id', cameraId)
                    .eq('user_id', userId)
                    .order('timestamp', { ascending: false })
                    .limit(20);
                return { data, error };
            }
            const detections = JSON.parse(localStorage.getItem('osha_detections') || '[]')
                .filter(d => d.camera_id === cameraId && d.user_id === userId)
                .slice(0, 20);
            return { data: detections, error: null };
        },

        // Real-time subscription for instant alert delivery
        subscribeToDetections(userId, onNewDetection) {
            if (supabase) {
                const channel = supabase
                    .channel('detections-realtime')
                    .on(
                        'postgres_changes',
                        {
                            event: '*',
                            schema: 'public',
                            table: 'detections',
                            filter: `user_id=eq.${userId}`
                        },
                        (payload) => {
                            console.log(`[Realtime] New detection received (${payload.eventType}):`, payload.new);
                            onNewDetection(payload.new, payload.eventType);
                        }
                    )
                    .subscribe((status) => {
                        console.log('[Realtime] Subscription status:', status);
                    });
                return channel;
            }
            // Mock: listen for local events
            const handler = (e) => {
                onNewDetection(e.detail.detection);
            };
            window.addEventListener('osha-live-detection', handler);
            return { unsubscribe: () => window.removeEventListener('osha-live-detection', handler) };
        }
    };

    // Expose raw supabase instance for Realtime subscriptions
    dbClient.supabase = supabase;

    window.dbClient = dbClient;

})();

