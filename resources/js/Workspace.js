export default class Workspace {

    constructor(container) {
        this.container = container;
        this.echo = null;
        this.started = false;
        this.storeSubscriber = null;
        this.lastValues = {};
        this.lastMetaValues = {};
        this.self = null;
        this.initialStateUpdated = false;

        this.debouncedBroadcastValueChangeFuncsByHandle = {};
        this.debouncedBroadcastMetaChangeFuncsByHandle = {};
    }

    start() {
        if (this.started) return;

        this.initializeEcho();
        this.initializeStore();
        this.initializeFocus();
        this.initializeValuesAndMeta();
        this.initializeHooks();
        this.initializeStatusBar();
        this.started = true;
    }

    destroy() {
        this.storeSubscriber.apply();
        this.echo.leave(this.channelName);
    }

    initializeEcho() {
        const reference = this.container.reference.replace('::', '.');
        this.channelName = `${reference}.${this.container.site}`;
        this.channel = this.echo.join(this.channelName);

        this.channel.on('pusher:subscription_succeeded', (data) => { // "here"
            this.self = data.me;

            this.subscribeToVuexMutations();

            const users = Object.keys(data.members).map((id) => ({ id, info: data.members[id] }));
            Statamic.$store.commit(`collaboration/${this.channelName}/setUsers`, users);
            Statamic.$hooks.run('user.set', {
                collection: this.container.blueprint,
                users: users,
            });

            // expect init state
            this.listenForWhisper(`initialize-state-for-${this.self.id}`, payload => {
                if (this.initialStateUpdated) return;
                this.debug('✅ Applying broadcasted state change', payload);
                Statamic.$store.dispatch(`publish/${this.container.name}/setValues`, payload.values);
                Statamic.$store.dispatch(`publish/${this.container.name}/setMeta`, this.restoreEntireMetaPayload(payload.meta));
                _.each(payload.focus, ({ handle }, user) => this.focusAndLock(user, handle));
                this.initialStateUpdated = true;
            });
        });

        this.channel.on('pusher:member_added', user => { // "joining"
            if (!Statamic.$store.state.collaboration[this.channelName].users.some(u => u.info.id === user.info.id)) {
                // actual new user, not just a new session by a known user
                Statamic.$toast.success(`${user.info.name} has joined.`);
                this.playAudio('buddy-in');
            }
            Statamic.$store.commit(`collaboration/${this.channelName}/addUser`, user);
            this.whisper(`initialize-state-for-${user.id}`, {
                values: Statamic.$store.state.publish[this.container.name].values,
                meta: this.cleanEntireMetaPayload(Statamic.$store.state.publish[this.container.name].meta),
                focus: Statamic.$store.state.collaboration[this.channelName].focus,
            });
        });

        this.channel.on('pusher:member_removed', user => { // "leaving"
            this.blurAndUnlock(user.id);
            Statamic.$store.commit(`collaboration/${this.channelName}/removeUser`, user);
            if (!Statamic.$store.state.collaboration[this.channelName].users.some(u => u.info.id === user.info.id)) {
                // user closed last session
                Statamic.$toast.success(`${user.info.name} has left.`);
                this.playAudio('buddy-out');
            }
        });

        this.listenForWhisper('updated', e => {
            this.applyBroadcastedValueChange(e);
        });

        this.listenForWhisper('meta-updated', e => {
            this.applyBroadcastedMetaChange(e);
        });

        this.listenForWhisper('focus', ({ user, handle }) => {
            this.debug(`Heard that user has changed focus`, { user, handle });
            this.focusAndLock(user, handle);
        });

        this.listenForWhisper('blur', ({ user, handle }) => {
            this.debug(`Heard that user has blurred`, { user, handle });
            this.blurAndUnlock(user, handle);
        });

        this.listenForWhisper('force-unlock', ({ targetUser, originUser }) => {
            this.debug(`Heard that user has requested another be unlocked`, { targetUser, originUser });

            if (targetUser !== this.self.info.id) return; // force-unlock applies to all sessions by a user

            document.activeElement.blur();
            this.blurAndUnlock(this.self.id);
            this.whisper('blur', { user: this.self.id });
            Statamic.$toast.info(`${originUser.name} has unlocked your editor.`, { duration: false });
        });

        this.listenForWhisper('saved', ({ user }) => {
            const userInfo = Statamic.$store.state.collaboration[this.channelName].users.find(u => u.id == user).info;
            this.container.saved();
            Statamic.$toast.success(`Saved by ${userInfo.name}.`);
        });

        this.listenForWhisper('published', ({ user, message }) => {
            const userInfo = Statamic.$store.state.collaboration[this.channelName].users.find(u => u.id == user).info;
            Statamic.$toast.success(`Published by ${userInfo.name}.`);
            const messageProp = message
                ? `Entry has been published by ${userInfo.name} with the message: ${message}`
                : `Entry has been published by ${userInfo.name} with no message.`
            Statamic.$components.append('CollaborationBlockingNotification', {
                props: { message: messageProp }
            }).on('confirm', () => window.location.reload());
        });

        this.listenForWhisper('revision-restored', ({ user }) => {
            const userInfo = Statamic.$store.state.collaboration[this.channelName].users.find(u => u.id == user).info;
            Statamic.$toast.success(`Revision restored by ${userInfo.name}.`);
            Statamic.$components.append('CollaborationBlockingNotification', {
                props: { message: `Entry has been restored to another revision by ${userInfo.name}` }
            }).on('confirm', () => window.location.reload());
            this.destroy(); // Stop listening to anything else.
        });
    }

    initializeStore() {
        Statamic.$store.registerModule(['collaboration', this.channelName], {
            namespaced: true,
            state: {
                users: [],
                focus: {},
            },
            mutations: {
                setUsers(state, users) {
                    state.users = users;
                },
                addUser(state, user) {
                    state.users.push(user);
                },
                removeUser(state, removedUser) {
                    state.users = state.users.filter(user => user.id !== removedUser.id);
                },
                focus(state, { handle, user }) {
                    Vue.set(state.focus, user, { handle });
                },
                blur(state, user) {
                    Vue.delete(state.focus, user);
                }
            }
        });
    }

    initializeStatusBar() {
        const component = this.container.pushComponent('CollaborationStatusBar', {
            props: {
                channelName: this.channelName,
                connecting: this.connecting,
            }
        });

        component.on('unlock', (targetUser) => {
            this.whisper('force-unlock', { targetUser, originUser: this.self.id });
        });
    }

    initializeHooks() {
        Statamic.$hooks.on('entry.saved', (resolve, reject, { reference }) => {
            if (reference === this.container.reference) {
                this.whisper('saved', { user: this.self.id });
            }
            resolve();
        });

        Statamic.$hooks.on('entry.published', (resolve, reject, { reference, message }) => {
            if (reference === this.container.reference) {
                this.whisper('published', { user: this.self.id, message });
            }
            resolve();
        });

        Statamic.$hooks.on('revision.restored', (resolve, reject, { reference }) => {
            if (reference !== this.container.reference) return resolve();

            this.whisper('revision-restored', { user: this.self.id });

            // Echo doesn't give us a promise, so wait half a second before resolving.
            // That should be enough time for the whisper to be sent before the the page refreshes.
            setTimeout(resolve, 500);
        });
    }

    initializeFocus() {
        this.container.$on('focus', handle => {
            if (!this.self) return;
            this.focus(this.self.id, handle);
            this.whisper('focus', { user: this.self.id, handle });
        });
        this.container.$on('blur', handle => {
            if (!this.self) return;
            this.blur(this.self.id);
            this.whisper('blur', { user: this.self.id, handle });
        });
    }

    focus(user, handle) {
        Statamic.$store.commit(`collaboration/${this.channelName}/focus`, { user, handle });
    }

    focusAndLock(user, handle) {
        this.focus(user, handle);
        const userInfo = Statamic.$store.state.collaboration[this.channelName].users.find(u => u.id == user).info;
        Statamic.$store.commit(`publish/${this.container.name}/lockField`, { user: userInfo, handle });
    }

    blur(user) {
        Statamic.$store.commit(`collaboration/${this.channelName}/blur`, user);
    }

    blurAndUnlock(user, handle = null) {
        handle = handle || Statamic.$store.state.collaboration[this.channelName]?.focus[user]?.handle;
        if (!handle) return;
        this.blur(user);
        Statamic.$store.commit(`publish/${this.container.name}/unlockField`, handle);
    }

    subscribeToVuexMutations() {
        this.storeSubscriber = Statamic.$store.subscribe((mutation, state) => {
            switch (mutation.type) {
                case `publish/${this.container.name}/setFieldValue`:
                    this.vuexFieldValueHasBeenSet(mutation.payload);
                    break;
                case `publish/${this.container.name}/setFieldMeta`:
                    this.vuexFieldMetaHasBeenSet(mutation.payload);
                    break;
            }
        });
    }

    // A field's value has been set in the vuex store.
    // It could have been triggered by the current user editing something,
    // or by the workspace applying a change dispatched by another user editing something.
    vuexFieldValueHasBeenSet(payload) {
        this.debug('Vuex field value has been set', payload);
        if (!this.valueHasChanged(payload.handle, payload.value)) {
            // No change? Don't bother doing anything.
            this.debug(`Value for ${payload.handle} has not changed.`, { value: payload.value, lastValue: this.lastValues[payload.handle] });
            return;
        }

        this.rememberValueChange(payload.handle, payload.value);
        this.debouncedBroadcastValueChangeFuncByHandle(payload.handle)(payload);
    }

    // A field's meta value has been set in the vuex store.
    // It could have been triggered by the current user editing something,
    // or by the workspace applying a change dispatched by another user editing something.
    vuexFieldMetaHasBeenSet(payload) {
        this.debug('Vuex field meta has been set', payload);
        if (!this.metaHasChanged(payload.handle, payload.value)) {
            // No change? Don't bother doing anything.
            this.debug(`Meta for ${payload.handle} has not changed.`, { value: payload.value, lastValue: this.lastMetaValues[payload.handle] });
            return;
        }

        this.rememberMetaChange(payload.handle, payload.value);
        this.debouncedBroadcastMetaChangeFuncByHandle(payload.handle)(payload);
    }

    rememberValueChange(handle, value) {
        this.debug('Remembering value change', { handle, value });
        this.lastValues[handle] = clone(value);
    }

    rememberMetaChange(handle, value) {
        this.debug('Remembering meta change', { handle, value });
        this.lastMetaValues[handle] = clone(value);
    }

    debouncedBroadcastValueChangeFuncByHandle(handle) {
        // use existing debounced function if one already exists
        const func = this.debouncedBroadcastValueChangeFuncsByHandle[handle];
        if (func) return func;

        // if the handle has no debounced broadcast function yet, create one and return it
        this.debouncedBroadcastValueChangeFuncsByHandle[handle] = _.debounce((payload) => {
            this.broadcastValueChange(payload);
        }, 500);
        return this.debouncedBroadcastValueChangeFuncsByHandle[handle];
    }

    debouncedBroadcastMetaChangeFuncByHandle(handle) {
        // use existing debounced function if one already exists
        const func = this.debouncedBroadcastMetaChangeFuncsByHandle[handle];
        if (func) return func;

        // if the handle has no debounced broadcast function yet, create one and return it
        this.debouncedBroadcastMetaChangeFuncsByHandle[handle] = _.debounce((payload) => {
            this.broadcastMetaChange(payload);
        }, 500);
        return this.debouncedBroadcastMetaChangeFuncsByHandle[handle];
    }

    valueHasChanged(handle, newValue) {
        const lastValue = this.lastValues[handle] || null;
        return JSON.stringify(lastValue) !== JSON.stringify(newValue);
    }

    metaHasChanged(handle, newValue) {
        const lastValue = this.lastMetaValues[handle] || null;
        return JSON.stringify(lastValue) !== JSON.stringify(newValue);
    }

    broadcastValueChange(payload) {
        // Only my own change events should be broadcasted. Otherwise when other users receive
        // the broadcast, it will be re-broadcasted, and so on, to infinity and beyond.
        if (payload.user === this.self.info.id && !payload.user.includes('#')) {
            payload.user = this.self.id // override with tab-specific ID
            this.whisper('updated', payload);
        }
    }

    broadcastMetaChange(payload) {
        // Only my own change events should be broadcasted. Otherwise when other users receive
        // the broadcast, it will be re-broadcasted, and so on, to infinity and beyond.
        if (payload.user === this.self.info.id && !payload.user.includes('#')) {
            payload.user = this.self.id // override with tab-specific ID
            this.whisper('meta-updated', this.cleanMetaPayload(payload));
        }
    }

    // Allow fieldtypes to provide an array of keys that will be broadcasted.
    // For example, in Bard, only the "existing" value in its meta object
    // ever gets updated. We'll just broadcast that, rather than the
    // whole thing, which would be wasted bytes in the message.
    cleanMetaPayload(payload) {
        const allowed = data_get(payload, 'value.__collaboration');
        if (! allowed) return payload;
        let allowedValues = {};
        allowed.forEach(key => allowedValues[key] = payload.value[key]);
        payload.value = allowedValues;
        return payload;
    }

    // Similar to cleanMetaPayload, except for when dealing with the
    // entire list of fields' meta values. Used when a user joins
    // and needs to receive everything in one fell swoop.
    cleanEntireMetaPayload(values) {
        return _.mapObject(values, meta => {
            const allowed = data_get(meta, '__collaboration');
            if (!allowed) return meta;
            let allowedValues = {};
            allowed.forEach(key => allowedValues[key] = meta[key]);
            return allowedValues;
        });
    }

    restoreEntireMetaPayload(payload) {
        return _.mapObject(payload, (value, key) => {
            return { ...this.lastMetaValues[key], ...value };
        });
    }

    applyBroadcastedValueChange(payload) {
        this.debug('✅ Applying broadcasted value change', payload);
        Statamic.$store.dispatch(`publish/${this.container.name}/setFieldValue`, payload);
    }

    applyBroadcastedMetaChange(payload) {
        this.debug('✅ Applying broadcasted meta change', payload);
        let value = { ...this.lastMetaValues[payload.handle], ...payload.value };
        payload.value = value;
        Statamic.$store.dispatch(`publish/${this.container.name}/setFieldMeta`, payload);
    }

    debug(message, args) {
        console.log('[Collaboration]', message, { ...args });
    }

    isAlone() {
        return Statamic.$store.state.collaboration[this.channelName].users.length === 1;
    }

    whisper(event, payload) {
        if (this.isAlone()) return;

        const chunkSize = 2500;
        const str = JSON.stringify(payload);
        const msgId = Math.random() + '';

        if (str.length < chunkSize) {
            this.debug(`📣 Broadcasting "${event}"`, payload);
            this.channel.whisper(event, payload);
            return;
        }

        event = `chunked-${event}`;

        for (let i = 0; i * chunkSize < str.length; i++) {
            const chunk = {
                id: msgId,
                index: i,
                chunk: str.substr(i * chunkSize, chunkSize),
                final: chunkSize * (i + 1) >= str.length
            };
            this.debug(`📣 Broadcasting "${event}"`, chunk);
            this.channel.whisper(event, chunk);
        }
    }

    listenForWhisper(event, callback) {
        this.channel.listenForWhisper(event, callback);

        let events = {};
        this.channel.listenForWhisper(`chunked-${event}`, data => {
            if (! events.hasOwnProperty(data.id)) {
                events[data.id] = { chunks: [], receivedFinal: false };
            }

            let e = events[data.id];
            e.chunks[data.index] = data.chunk;
            if (data.final) e.receivedFinal = true;
            if (e.receivedFinal && e.chunks.length === Object.keys(e.chunks).length) {
                callback(JSON.parse(e.chunks.join('')));
                delete events[data.id];
            }
        });
    }

    playAudio(file) {
        let el = document.createElement('audio');
        el.src = cp_url(`../vendor/statamic/collaboration/resources/audio/${file}.mp3`);
        document.body.appendChild(el);
        el.volume = 0.25;
        el.addEventListener('ended', () => el.remove());
        el.play();
    }

    initializeValuesAndMeta() {
        this.lastValues = clone(Statamic.$store.state.publish[this.container.name].values);
        this.lastMetaValues = clone(Statamic.$store.state.publish[this.container.name].meta);
    }
}
