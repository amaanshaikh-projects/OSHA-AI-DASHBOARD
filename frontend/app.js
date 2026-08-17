/* ==========================================================================
   OSHA AI Premium SaaS Homepage - Application Logic (2026 Edition)
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize Lucide Icons
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    // 2. Scroll-Aware Navigation
    const navbar = document.getElementById('navbar');
    window.addEventListener('scroll', () => {
        if (window.scrollY > 40) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    });

    // 3. Mobile Navigation Drawer
    const mobileToggle = document.getElementById('mobile-toggle');
    const mobileDrawer = document.getElementById('mobile-drawer');

    if (mobileToggle && mobileDrawer) {
        mobileToggle.addEventListener('click', () => {
            const expanded = mobileToggle.getAttribute('aria-expanded') === 'true';
            mobileToggle.setAttribute('aria-expanded', !expanded);
            mobileDrawer.classList.toggle('open');

            // Toggle icon
            const icon = mobileToggle.querySelector('i');
            if (icon && typeof lucide !== 'undefined') {
                if (expanded) {
                    icon.setAttribute('data-lucide', 'menu');
                } else {
                    icon.setAttribute('data-lucide', 'x');
                }
                lucide.createIcons({
                    attrs: {
                        'data-lucide': icon.getAttribute('data-lucide')
                    },
                    name: 'x'
                });
            }
        });

        // Close drawer on link click
        mobileDrawer.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                mobileToggle.setAttribute('aria-expanded', 'false');
                mobileDrawer.classList.remove('open');
                const icon = mobileToggle.querySelector('i');
                if (icon) icon.setAttribute('data-lucide', 'menu');
                if (typeof lucide !== 'undefined') lucide.createIcons();
            });
        });
    }

    // 4. Ambient Particles Network Canvas (60 FPS)
    const canvas = document.getElementById('ambient-particles');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        let particles = [];
        let mouse = { x: null, y: null, radius: 150 };

        const resizeCanvas = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            initParticles();
        };

        class Particle {
            constructor(x, y) {
                this.x = x;
                this.y = y;
                this.baseX = x;
                this.baseY = y;
                this.size = Math.random() * 2 + 1;
                this.density = (Math.random() * 30) + 10;
                this.color = 'rgba(37, 99, 235, 0.15)'; // Soft blue glow particle
                this.vx = (Math.random() - 0.5) * 0.4;
                this.vy = (Math.random() - 0.5) * 0.4;
            }

            draw() {
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
                ctx.fillStyle = this.color;
                ctx.fill();
            }

            update() {
                // Return to base position / float around
                this.x += this.vx;
                this.y += this.vy;

                // Bounce at boundaries
                if (this.x < 0 || this.x > canvas.width) this.vx = -this.vx;
                if (this.y < 0 || this.y > canvas.height) this.vy = -this.vy;

                // Interactive Mouse Parallax
                if (mouse.x !== null && mouse.y !== null) {
                    let dx = mouse.x - this.x;
                    let dy = mouse.y - this.y;
                    let distance = Math.sqrt(dx * dx + dy * dy);
                    if (distance < mouse.radius) {
                        let force = (mouse.radius - distance) / mouse.radius;
                        let directionX = dx / distance;
                        let directionY = dy / distance;
                        this.x -= directionX * force * 15;
                        this.y -= directionY * force * 15;
                    }
                }
            }
        }

        const initParticles = () => {
            particles = [];
            const numberOfParticles = Math.min(Math.floor((canvas.width * canvas.height) / 18000), 75);
            for (let i = 0; i < numberOfParticles; i++) {
                const x = Math.random() * canvas.width;
                const y = Math.random() * canvas.height;
                particles.push(new Particle(x, y));
            }
        };

        const connect = () => {
            let opacityValue = 1;
            for (let a = 0; a < particles.length; a++) {
                for (let b = a; b < particles.length; b++) {
                    let dx = particles[a].x - particles[b].x;
                    let dy = particles[a].y - particles[b].y;
                    let distance = Math.sqrt(dx * dx + dy * dy);

                    if (distance < 120) {
                        opacityValue = 1 - (distance / 120);
                        ctx.strokeStyle = `rgba(37, 99, 235, ${opacityValue * 0.08})`;
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.moveTo(particles[a].x, particles[a].y);
                        ctx.lineTo(particles[b].x, particles[b].y);
                        ctx.stroke();
                    }
                }
            }
        };

        const animate = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            particles.forEach(p => {
                p.update();
                p.draw();
            });
            connect();
            requestAnimationFrame(animate);
        };

        window.addEventListener('resize', resizeCanvas);
        window.addEventListener('mousemove', (e) => {
            mouse.x = e.x;
            mouse.y = e.y;
        });
        window.addEventListener('mouseleave', () => {
            mouse.x = null;
            mouse.y = null;
        });

        resizeCanvas();
        animate();
    }

    // 5. Hero Dashboard Live Simulated Updates
    const heroAlertStream = document.getElementById('hero-alert-stream');
    const heroCameraItems = document.querySelectorAll('.cam-feed-item');

    const heroSimData = [
        {
            camId: 'front-door',
            alertTitle: 'Package Delivered',
            alertIcon: 'package',
            confidence: '98%',
            colorClass: 'text-blue'
        },
        {
            camId: 'garage',
            alertTitle: 'Garage Door Open',
            alertIcon: 'door-open',
            confidence: '99%',
            colorClass: 'text-emerald'
        },
        {
            camId: 'front-door',
            alertTitle: 'Delivery Person Detected',
            alertIcon: 'user',
            confidence: '95%',
            colorClass: 'text-blue'
        }
    ];

    let currentHeroSimIndex = 0;

    const triggerHeroSimulationStep = () => {
        const step = heroSimData[currentHeroSimIndex];

        // Update active feed items classes
        heroCameraItems.forEach(item => {
            if (item.getAttribute('data-cam-id') === step.camId) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });

        // Insert new alert element to top
        const alertHtml = `
            <div class="alert-item animate-in">
                <div class="alert-header">
                    <span class="alert-camera-name">${step.camId === 'front-door' ? 'Front Door' : 'Garage'}</span>
                    <span class="alert-time">Just now</span>
                </div>
                <div class="alert-body">
                    <i data-lucide="${step.alertIcon}" class="alert-type-icon ${step.colorClass}"></i>
                    <span class="alert-desc">${step.alertTitle}</span>
                </div>
                <div class="alert-confidence">
                    <div class="conf-bar" style="width: ${step.confidence}"></div>
                    <span>${step.confidence} Confidence</span>
                </div>
            </div>
        `;

        heroAlertStream.insertAdjacentHTML('afterbegin', alertHtml);
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }

        // Limit stack to 3
        const alerts = heroAlertStream.querySelectorAll('.alert-item');
        if (alerts.length > 3) {
            alerts[alerts.length - 1].remove();
        }

        currentHeroSimIndex = (currentHeroSimIndex + 1) % heroSimData.length;
    };

    // Cycle simulator triggers
    setInterval(triggerHeroSimulationStep, 4500);

    // 6. Interactive Prompt & Thinking Simulator
    const selectorButtons = document.querySelectorAll('.selector-btn');
    const promptTextContainer = document.getElementById('simulator-prompt-text');

    // Flowchart Node Selectors
    const flowNodes = {
        prompt: document.getElementById('node-prompt'),
        brain: document.getElementById('node-brain'),
        analysis: document.getElementById('node-analysis'),
        decision: document.getElementById('node-decision'),
        notification: document.getElementById('node-notification')
    };

    const flowDetailImg = document.getElementById('flow-snap-img');
    const flowBoundBox = document.getElementById('flow-bound-box');
    const flowAction = document.getElementById('flow-action');
    const flowReasoning = document.getElementById('flow-reasoning');
    const flowConfidence = document.getElementById('flow-confidence');

    const cameraConfigurations = {
        'front-door': {
            promptText: "Notify me when someone approaches the door.",
            snapClass: "detail-snap-front-door",
            boundBox: { top: "20%", left: "42%", width: "24%", height: "65%" },
            flowDetails: [
                { action: "Parsing input vector...", reasoning: "Compiling natural language rules...", confidence: "0%" },
                { action: "Generating trigger matrix...", reasoning: "Target classification: [Human], Proximity: [Immediate]", confidence: "32%" },
                { action: "Scanning scene shapes...", reasoning: "Evaluating pixel motion segments...", confidence: "58%" },
                { action: "Target evaluated.", reasoning: "Delivery worker detected carrying card box at entrance.", confidence: "98.4%" },
                { action: "Alert successfully dispatched.", reasoning: "Event trigger MATCH. Sending webhook.", confidence: "98.4%" }
            ]
        },
        'warehouse': {
            promptText: "Notify me if the warehouse loading dock is blocked.",
            snapClass: "detail-snap-warehouse",
            boundBox: { top: "25%", left: "15%", width: "70%", height: "60%" },
            flowDetails: [
                { action: "Parsing input vector...", reasoning: "Compiling rules: [Obstruction] on [Loading Zone]", confidence: "0%" },
                { action: "Calibrating grid area...", reasoning: "Setting focal sector: Dock Gate 3", confidence: "45%" },
                { action: "Analyzing structural bounds...", reasoning: "Static silhouette match against grid...", confidence: "68%" },
                { action: "Dock Obstruction confirmed.", reasoning: "Flatbed freight trailer standing in active bay over 5 mins.", confidence: "96.5%" },
                { action: "Dock Alert triggered.", reasoning: "Event trigger MATCH. Forwarding to Logistics hub.", confidence: "96.5%" }
            ]
        },
        'living-room': {
            promptText: "Alert me when my dog jumps onto the couch.",
            snapClass: "detail-snap-front-door", // share gradient visual
            boundBox: { top: "35%", left: "30%", width: "40%", height: "50%" },
            flowDetails: [
                { action: "Parsing input vector...", reasoning: "Filter constraints: [Class: Dog], [Couch boundary]", confidence: "0%" },
                { action: "Segmenting furniture lines...", reasoning: "Anchor reference target: Fabric Sofa A", confidence: "40%" },
                { action: "Evaluating subject vector...", reasoning: "Object classification: [Canine]. Tracking trajectory.", confidence: "72%" },
                { action: "Couch boundary violation.", reasoning: "Golden Retriever shape static coordinates inside sofa space.", confidence: "95.1%" },
                { action: "Triggering smart alert.", reasoning: "Dog on couch. Activating speaker cue.", confidence: "95.1%" }
            ]
        },
        'garage': {
            promptText: "Tell me when the garage stays open for more than five minutes.",
            snapClass: "detail-snap-warehouse",
            boundBox: { top: "10%", left: "20%", width: "60%", height: "75%" },
            flowDetails: [
                { action: "Parsing input vector...", reasoning: "Logic constraint: [Gate Open State] > 300 seconds", confidence: "0%" },
                { action: "Measuring roller gate index...", reasoning: "Current position: Retracted [Open]", confidence: "50%" },
                { action: "Awaiting timeout limit...", reasoning: "Frame state check: elapsed 302 seconds", confidence: "80%" },
                { action: "Timeout limit exceeded.", reasoning: "Garage roll-up gate has remained fully open for 5.03 mins.", confidence: "99.2%" },
                { action: "Sending Open warning.", reasoning: "Triggering notification notification.", confidence: "99.2%" }
            ]
        },
        'nursery': {
            promptText: "Notify me when the baby stands in the crib.",
            snapClass: "detail-snap-front-door",
            boundBox: { top: "30%", left: "40%", width: "25%", height: "50%" },
            flowDetails: [
                { action: "Parsing input vector...", reasoning: "Target: [Toddler], Posture: [Standing] inside [Crib Boundary]", confidence: "0%" },
                { action: "Tracking joint keypoints...", reasoning: "Locating torso relative to floor base...", confidence: "48%" },
                { action: "Calculating height delta...", reasoning: "Keypoint coordinate checks relative to rail level", confidence: "78%" },
                { action: "Standing position detected.", reasoning: "Child head position has exceeded crib rail baseline limit.", confidence: "97.6%" },
                { action: "Sending nursery alarm.", reasoning: "Event trigger MATCH. Dispatching priority push alert.", confidence: "97.6%" }
            ]
        }
    };

    let typingTimeout;
    let flowTimeouts = [];

    const typePromptText = (text, callback) => {
        let index = 0;
        promptTextContainer.textContent = '';

        const typeChar = () => {
            if (index < text.length) {
                promptTextContainer.textContent += text.charAt(index);
                index++;
                typingTimeout = setTimeout(typeChar, 35);
            } else if (callback) {
                callback();
            }
        };
        typeChar();
    };

    const runFlowchartAnimation = (config) => {
        // Clear previous flowchart runs
        flowTimeouts.forEach(clearTimeout);
        flowTimeouts = [];

        // Reset node classes
        Object.values(flowNodes).forEach(node => {
            node.classList.remove('active', 'success');
        });

        // Reset scanning bounding box
        flowBoundBox.style.display = 'none';
        flowBoundBox.style.opacity = '0';

        // Set up snapshot class
        flowDetailImg.className = 'detail-snapshot-img';
        flowDetailImg.classList.add(config.snapClass);

        const nodes = ['prompt', 'brain', 'analysis', 'decision', 'notification'];

        nodes.forEach((nodeName, index) => {
            const t = setTimeout(() => {
                // Success for preceding node
                if (index > 0) {
                    flowNodes[nodes[index - 1]].classList.remove('active');
                    flowNodes[nodes[index - 1]].classList.add('success');
                }

                // Active current
                flowNodes[nodeName].classList.add('active');

                // Update detailed explanation blocks
                const detail = config.flowDetails[index];
                flowAction.textContent = detail.action;
                flowReasoning.textContent = `"${detail.reasoning}"`;
                flowConfidence.textContent = detail.confidence;

                // Specific actions during analysis & decision nodes
                if (nodeName === 'analysis') {
                    // Scanning laser effect highlighted
                }

                if (nodeName === 'decision') {
                    // Show target bounding boxes
                    flowBoundBox.style.display = 'block';
                    flowBoundBox.style.top = config.boundBox.top;
                    flowBoundBox.style.left = config.boundBox.left;
                    flowBoundBox.style.width = config.boundBox.width;
                    flowBoundBox.style.height = config.boundBox.height;
                    setTimeout(() => { flowBoundBox.style.opacity = '1'; }, 50);
                }

                if (nodeName === 'notification') {
                    flowNodes.notification.classList.remove('active');
                    flowNodes.notification.classList.add('success');
                }

            }, index * 1200);

            flowTimeouts.push(t);
        });
    };

    const handleCameraSwitch = (targetCamId) => {
        const config = cameraConfigurations[targetCamId];
        if (!config) return;

        // Clear typewriter
        clearTimeout(typingTimeout);

        // Typewriter run
        typePromptText(config.promptText, () => {
            runFlowchartAnimation(config);
        });
    };

    // Set click handlers on camera triggers
    selectorButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('active')) return;

            selectorButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const target = btn.getAttribute('data-target');
            handleCameraSwitch(target);
        });
    });

    // Run first step instantly
    handleCameraSwitch('front-door');

    // 7. How It Works Timeline Scroll Observer
    const timelineProgress = document.getElementById('timeline-progress');
    const timelineSteps = document.querySelectorAll('.timeline-step');
    const howItWorksSection = document.getElementById('how-it-works');

    const updateTimelineProgress = () => {
        if (!howItWorksSection) return;

        const rect = howItWorksSection.getBoundingClientRect();
        const sectionHeight = rect.height;
        const windowHeight = window.innerHeight;

        // Calculate percentage of section scrolled
        // 0% at bottom of screen, 100% when scrolled past
        let percent = ((windowHeight - rect.top) / (sectionHeight + windowHeight / 2)) * 100;
        percent = Math.max(0, Math.min(100, percent));

        if (timelineProgress) {
            timelineProgress.style.width = `${percent}%`;
        }

        // Add active classes to milestones
        timelineSteps.forEach((step, index) => {
            const triggerPoints = [15, 40, 65, 85];
            if (percent >= triggerPoints[index]) {
                step.classList.add('active');
            } else {
                step.classList.remove('active');
            }
        });
    };

    window.addEventListener('scroll', updateTimelineProgress);
    updateTimelineProgress();

    // 8. Pricing Plan Toggle Switching
    const priceToggle = document.getElementById('price-toggle');
    const labelMonthly = document.getElementById('lbl-monthly');
    const labelYearly = document.getElementById('lbl-yearly');
    const priceStarter = document.getElementById('price-starter');
    const pricePro = document.getElementById('price-pro');

    if (priceToggle && priceStarter && pricePro) {
        priceToggle.addEventListener('click', () => {
            const isYearly = priceToggle.classList.toggle('active');

            if (isYearly) {
                labelMonthly.classList.remove('active');
                labelYearly.classList.add('active');

                // Animate counts down (20% discount)
                animatePrice(priceStarter, 29, 23);
                animatePrice(pricePro, 69, 55);
            } else {
                labelMonthly.classList.add('active');
                labelYearly.classList.remove('active');

                // Animate counts up
                animatePrice(priceStarter, 23, 29);
                animatePrice(pricePro, 55, 69);
            }
        });
    }

    const animatePrice = (element, start, end) => {
        let current = start;
        const duration = 250; // ms
        const steps = 15;
        const stepTime = duration / steps;
        const delta = (end - start) / steps;

        let currentStep = 0;
        const timer = setInterval(() => {
            current += delta;
            element.textContent = Math.round(current);
            currentStep++;
            if (currentStep >= steps) {
                element.textContent = end;
                clearInterval(timer);
            }
        }, stepTime);
    };

    // 9. FAQ Accordion Expanding logic
    const accordionTriggers = document.querySelectorAll('.accordion-trigger');
    accordionTriggers.forEach(trigger => {
        trigger.addEventListener('click', () => {
            const item = trigger.closest('.accordion-item');
            const content = item.querySelector('.accordion-content');
            const isActive = item.classList.contains('expanded');

            // Close all open items
            document.querySelectorAll('.accordion-item').forEach(accItem => {
                accItem.classList.remove('expanded');
                accItem.querySelector('.accordion-content').style.maxHeight = null;
                accItem.querySelector('.accordion-trigger').setAttribute('aria-expanded', 'false');
            });

            if (!isActive) {
                item.classList.add('expanded');
                trigger.setAttribute('aria-expanded', 'true');
                // Set height to actual scroll height for smooth dynamic expand animation
                content.style.maxHeight = content.scrollHeight + 'px';
            }
        });
    });

    // 10. Intersection Observer scroll fade reveal system
    const revealItems = document.querySelectorAll('.reveal-item');
    if (revealItems.length > 0) {
        const revealObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('active');
                    // Stop observing once revealed to retain visual layout static
                    revealObserver.unobserve(entry.target);
                }
            });
        }, {
            threshold: 0.08,
            rootMargin: '0px 0px -20px 0px'
        });

        revealItems.forEach(item => {
            revealObserver.observe(item);
        });
    }

    // 11. Mouse Movement Tilt Parallax Effect on Cards
    const tiltCards = document.querySelectorAll('.showroom-card, .feature-card, .pricing-card, .testimonial-card');
    tiltCards.forEach(card => {
        card.addEventListener('mousemove', (e) => {
            // Check accessibility preferences for reduced motion
            const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (prefersReducedMotion) return;

            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left; // x coordinate within client bounding rect
            const y = e.clientY - rect.top;  // y coordinate within client bounding rect

            const centerX = rect.width / 2;
            const centerY = rect.height / 2;

            const rotateX = -(y - centerY) / 25; // max tilt degrees
            const rotateY = (x - centerX) / 25;

            card.style.transform = `translateY(-4px) perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
        });

        card.addEventListener('mouseleave', () => {
            card.style.transform = '';
        });
    });

    // Auth Session Check: Show profile chip if already signed in
    (async () => {
        try {
            const supabaseUrl = window.SUPABASE_URL;
            const supabaseAnon = window.SUPABASE_ANON_KEY;
            if (!supabaseUrl || !supabaseAnon || !window.supabase) return;

            const client = window.supabase.createClient(supabaseUrl, supabaseAnon);
            const { data: { session } } = await client.auth.getSession();

            if (session && session.user) {
                const user = session.user;

                // Get display name and avatar
                const name = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) || user.email.split('@')[0];
                const avatarUrl = user.user_metadata && (user.user_metadata.avatar_url || user.user_metadata.picture);

                // Populate the chip
                const avatarEl = document.getElementById('nav-user-avatar');
                const nameEl = document.getElementById('nav-user-name');
                if (avatarEl && nameEl) {
                    nameEl.textContent = name.split(' ')[0]; // First name only
                    if (avatarUrl) {
                        avatarEl.innerHTML = `<img src="${avatarUrl}" alt="${name}" referrerpolicy="no-referrer" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" onerror="this.onerror=null; this.style.display='none'; this.parentElement.textContent='${name.charAt(0).toUpperCase()}';">`;
                    } else {
                        avatarEl.textContent = name.charAt(0).toUpperCase();
                    }
                }

                // Swap buttons → profile chip
                const authBtns = document.getElementById('nav-auth-buttons');
                const userChip = document.getElementById('nav-user-chip');
                const drawerBtns = document.getElementById('drawer-auth-buttons');
                const drawerChip = document.getElementById('drawer-user-chip');

                if (authBtns) authBtns.style.display = 'none';
                if (userChip) userChip.style.display = 'flex';
                if (drawerBtns) drawerBtns.style.display = 'none';
                if (drawerChip) drawerChip.style.display = 'flex';

                // Fetch user profile to check subscription tier
                let subscriptionPlan = 'Free';
                try {
                    const { data: profile } = await client.from('profiles').select('subscription_plan').eq('id', user.id).single();
                    if (profile && profile.subscription_plan) {
                        subscriptionPlan = profile.subscription_plan;
                    }
                } catch (err) {
                    // Ignore errors, default to Free
                }

                // Apply Premium Profile Ring to nav-user-avatar
                if (avatarEl) {
                    const p = subscriptionPlan.toLowerCase();
                    avatarEl.classList.remove('premium-starter', 'premium-pro');
                    if (p === 'starter') avatarEl.classList.add('premium-starter');
                    if (p === 'pro') avatarEl.classList.add('premium-pro');
                }

                // Update Hero Button based on subscription and auth state
                const heroCtaBtn = document.getElementById('hero-cta-btn');
                if (heroCtaBtn) {
                    heroCtaBtn.href = 'dashboard.html#dashboard';
                    if (subscriptionPlan === 'Starter' || subscriptionPlan === 'Pro') 
                        {
                        heroCtaBtn.innerHTML = `Get Started <i data-lucide="arrow-right" class="btn-icon"></i>`;
                    } else {
                        heroCtaBtn.innerHTML = `Go to Dashboard <i data-lucide="arrow-right" class="btn-icon"></i>`;
                    }
                }

                // Re-render lucide icons for the dashboard icon inside the chip & hero button
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        } catch (e) {
            // Silently fail — user stays signed out state
            console.warn('[Auth Check] Could not verify session:', e);
        }
    })();
});
