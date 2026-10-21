-- Found in AUI: triggers
--
-- A trigger is a function that PostgreSQL runs by itself when a row is inserted,
-- updated or deleted. These keep the business rules inside the database, so they
-- hold no matter which program writes to it.


-- 1. Only allow sensible status changes for an item:
--      open -> claimed -> returned      (a found item goes back to its owner)
--      open -> returned                 (a lost item was recovered)
--      claimed -> open                  (the approved claim turned out to be wrong)
--    "returned" is final.
CREATE OR REPLACE FUNCTION check_status_change() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    IF (OLD.status = 'open' AND NEW.status IN ('claimed', 'returned'))
       OR (OLD.status = 'claimed' AND NEW.status IN ('open', 'returned')) THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Invalid status change from % to %', OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_status_change
BEFORE UPDATE OF status ON items
FOR EACH ROW EXECUTE FUNCTION check_status_change();


-- 2. Before a claim is saved, check that it makes sense:
--    you can only claim a found item, that is still open, and that you did not post yourself.
CREATE OR REPLACE FUNCTION check_new_claim() RETURNS TRIGGER AS $$
DECLARE
    claimed_item items%ROWTYPE;
BEGIN
    SELECT * INTO claimed_item FROM items WHERE item_id = NEW.item_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'This item does not exist';
    END IF;
    IF claimed_item.kind <> 'found' THEN
        RAISE EXCEPTION 'Only found items can be claimed';
    END IF;
    IF claimed_item.status <> 'open' THEN
        RAISE EXCEPTION 'This item is not open for claims anymore';
    END IF;
    IF claimed_item.reported_by = NEW.claimant_id THEN
        RAISE EXCEPTION 'You cannot claim an item you posted yourself';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_new_claim
BEFORE INSERT ON claims
FOR EACH ROW EXECUTE FUNCTION check_new_claim();


-- 3. When someone claims an item, tell the person who found it.
CREATE OR REPLACE FUNCTION notify_finder_of_claim() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO notifications (user_id, item_id, message)
    SELECT i.reported_by, i.item_id,
           'Someone claimed "' || i.title || '" that you found. Open the item to approve or reject the claim.'
    FROM items i
    WHERE i.item_id = NEW.item_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_finder_of_claim
AFTER INSERT ON claims
FOR EACH ROW EXECUTE FUNCTION notify_finder_of_claim();


-- 4. When the finder approves or rejects a claim:
--    approved -> the item becomes "claimed" and the claimant gets the finder's email
--    rejected -> the claimant is told, and the item stays open for other claims
CREATE OR REPLACE FUNCTION apply_claim_decision() RETURNS TRIGGER AS $$
DECLARE
    item_title  TEXT;
    finder_mail TEXT;
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    SELECT i.title, u.email INTO item_title, finder_mail
    FROM items i
    JOIN users u ON u.user_id = i.reported_by
    WHERE i.item_id = NEW.item_id;

    IF NEW.status = 'approved' THEN
        UPDATE items SET status = 'claimed' WHERE item_id = NEW.item_id;

        INSERT INTO notifications (user_id, item_id, message)
        VALUES (NEW.claimant_id, NEW.item_id,
                'Your claim on "' || item_title || '" was approved. Contact the finder at ' || finder_mail || '.');

    ELSIF NEW.status = 'rejected' THEN
        INSERT INTO notifications (user_id, item_id, message)
        VALUES (NEW.claimant_id, NEW.item_id,
                'Your claim on "' || item_title || '" was rejected by the finder.');
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER apply_claim_decision
AFTER UPDATE OF status ON claims
FOR EACH ROW EXECUTE FUNCTION apply_claim_decision();


-- 5. Automatic matching. When a new item is posted, look for items of the opposite kind
--    whose meaning is close, and notify the owner of the lost item.
--
--    <=> is the pgvector operator for cosine distance: 0 means the same meaning,
--    1 means unrelated. Two descriptions count as a match when their distance is
--    below max_distance. scripts/evaluate.js shows how this value was chosen.
--
--    A found item can't match something that was lost after it was found, so the
--    dates are compared too.
CREATE OR REPLACE FUNCTION notify_possible_matches() RETURNS TRIGGER AS $$
DECLARE
    max_distance CONSTANT REAL := 0.45;
BEGIN
    IF NEW.embedding IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.kind = 'found' THEN
        -- a new found item: tell the owners of similar lost items
        INSERT INTO notifications (user_id, item_id, message)
        SELECT lost.reported_by, NEW.item_id,
               'Someone found "' || NEW.title || '". It may be your "' || lost.title || '".'
        FROM items lost
        WHERE lost.kind = 'lost'
          AND lost.status = 'open'
          AND lost.reported_by <> NEW.reported_by
          AND lost.event_date <= NEW.event_date
          AND (lost.embedding <=> NEW.embedding) < max_distance
        ORDER BY lost.embedding <=> NEW.embedding
        LIMIT 5;
    ELSE
        -- a new lost item: tell its owner about similar items that were already found
        INSERT INTO notifications (user_id, item_id, message)
        SELECT NEW.reported_by, found.item_id,
               '"' || found.title || '" was found and may be your "' || NEW.title || '".'
        FROM items found
        WHERE found.kind = 'found'
          AND found.status = 'open'
          AND found.reported_by <> NEW.reported_by
          AND found.event_date >= NEW.event_date
          AND (found.embedding <=> NEW.embedding) < max_distance
        ORDER BY found.embedding <=> NEW.embedding
        LIMIT 5;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notify_possible_matches
AFTER INSERT ON items
FOR EACH ROW EXECUTE FUNCTION notify_possible_matches();
