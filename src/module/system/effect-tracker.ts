import type { ActorPF2e } from "@actor/base";
import { CreaturePF2e } from "@actor/creature";
import type { EffectPF2e } from "@item/index";
import { EncounterPF2e } from "@module/encounter";

export class EffectTracker {
    private trackedEffects: Embedded<EffectPF2e>[] = [];

    /** A separate collection of aura effects, including ones with unlimited duration */
    auraEffects: Collection<Embedded<EffectPF2e>> = new Collection();

    private insert(effect: Embedded<EffectPF2e>, duration: { expired: boolean; remaining: number }) {
        if (this.trackedEffects.length === 0) {
            this.trackedEffects.push(effect);
        } else {
            for (let index = 0; index < this.trackedEffects.length; index++) {
                const other = this.trackedEffects[index];
                const remaining = other.remainingDuration.remaining;
                // compare duration and insert if other effect has later expiration
                if (duration.remaining > remaining) {
                    // new effect has longer remaining duration - skip ahead
                } else if (remaining > duration.remaining) {
                    this.trackedEffects.splice(index, 0, effect);
                    return;
                } else if ((effect.system.start.initiative ?? 0) > (other.system.start.initiative ?? 0)) {
                    // new effect has later initiative - skip ahead
                } else if ((other.system.start.initiative ?? 0) > (effect.system.start.initiative ?? 0)) {
                    this.trackedEffects.splice(index, 0, effect);
                    return;
                } else if (
                    other.system.duration.expiry === "turn-start" &&
                    effect.system.duration.expiry === "turn-end"
                ) {
                    this.trackedEffects.splice(index, 0, effect);
                    return;
                }
            }
            this.trackedEffects.push(effect);
        }
    }

    register(effect: Embedded<EffectPF2e>): void {
        if (effect.fromAura && (canvas.ready || !effect.actor.isToken) && effect.id) {
            this.auraEffects.set(effect.uuid, effect);
        }

        const index = this.trackedEffects.findIndex((e) => e.id === effect.id);
        const systemData = effect.system;
        const duration = systemData.duration.unit;
        switch (duration) {
            case "unlimited":
            case "encounter": {
                if (duration === "unlimited") systemData.expired = false;
                if (index >= 0 && index < this.trackedEffects.length) {
                    this.trackedEffects.splice(index, 1);
                }
                return;
            }
            default: {
                const duration = effect.remainingDuration;
                effect.system.expired = duration.expired;
                if (this.trackedEffects.length === 0 || index < 0) {
                    this.insert(effect, duration);
                } else {
                    const existing = this.trackedEffects[index];
                    // compare duration and update if different
                    if (duration.remaining !== existing.remainingDuration.remaining) {
                        this.trackedEffects.splice(index, 1);
                        this.insert(effect, duration);
                    }
                }
            }
        }
    }

    unregister(toRemove: Embedded<EffectPF2e>): void {
        this.trackedEffects = this.trackedEffects.filter((effect) => effect !== toRemove);
        this.auraEffects.delete(toRemove.uuid);
    }

    async refresh(): Promise<void> {
        const expired: Embedded<EffectPF2e>[] = [];
        for (const effect of this.trackedEffects) {
            const duration = effect.remainingDuration;
            if (effect.system.expired !== duration.expired) {
                expired.push(effect);
            } else if (!duration.expired) {
                break;
            }
        }

        // Only update each actor once, and only the ones with effect expiry changes
        const updatedActors = expired
            .map((effect) => effect.actor)
            .reduce((actors: ActorPF2e[], actor) => {
                if (actor.isToken || !actors.some((other) => !other.isToken && other.id === actor.id)) {
                    actors.push(actor);
                }
                return actors;
            }, []);

        for (const actor of updatedActors) {
            actor.prepareData();
            actor.sheet.render(false);
            if (actor instanceof CreaturePF2e) {
                for (const token of actor.getActiveTokens()) {
                    await token.drawEffects();
                }
            }
        }

        if (game.settings.get("pf2e", "automation.removeExpiredEffects")) {
            for (const actor of updatedActors) {
                await this.removeExpired(actor);
            }
        }
    }

    async removeExpired(actor?: ActorPF2e): Promise<void> {
        const expired: Embedded<EffectPF2e>[] = [];
        for (const effect of this.trackedEffects) {
            if (actor && effect.actor !== actor) continue;

            const duration = effect.remainingDuration;
            if (duration.expired) {
                expired.push(effect);
            } else {
                break;
            }
        }

        const owners = actor
            ? [actor]
            : [...new Set(expired.map((effect) => effect.actor))].filter((owner) => game.actors.has(owner.id));
        for (const owner of owners.filter((a) => game.user === a.primaryUpdater)) {
            await owner.deleteEmbeddedDocuments(
                "Item",
                expired.flatMap((effect) => (owner.items.has(effect.id) ? effect.id : []))
            );
        }
    }

    /** Expire or remove on-encounter-end effects */
    async onEncounterEnd(encounter: EncounterPF2e): Promise<void> {
        const autoRemoveExpired = game.settings.get("pf2e", "automation.removeExpiredEffects");
        const autoExpireEffects = !autoRemoveExpired && game.settings.get("pf2e", "automation.effectExpiration");
        if (!(autoExpireEffects || autoRemoveExpired)) return;

        const actors = encounter.combatants.contents
            .flatMap((c) => c.actor ?? [])
            .filter((a) => game.user === a.primaryUpdater);

        for (const actor of actors) {
            const expiresNow = actor.itemTypes.effect.filter((e) => e.system.duration.unit === "encounter");
            if (expiresNow.length === 0) continue;

            if (autoExpireEffects) {
                const updates = expiresNow.map((e) => ({ _id: e.id, "system.expired": true }));
                await actor.updateEmbeddedDocuments("Item", updates);
            } else {
                const deletes = expiresNow.map((e) => e.id);
                await actor.deleteEmbeddedDocuments("Item", deletes);
            }

            for (const effect of expiresNow) {
                this.unregister(effect);
            }
        }
    }
}
